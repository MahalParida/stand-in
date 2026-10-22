/**
 * Host controller: owns the MCP session, the orchestrator conversation, call
 * polling, elicitation, hand-off and autoplay. React subscribes to it with
 * useSyncExternalStore; nothing in here touches the DOM except speech and
 * location.reload() for "Reset take".
 */
import {
  CALL_CARD_URI,
  CallStatusOutputSchema,
  GetCaseOutputSchema,
  HandoffToUserOutputSchema,
  ScheduleFollowupOutputSchema,
  OpenCaseOutputSchema,
  PlaceCallOutputSchema,
  TERMINAL_CALL_STATES,
  TOOL_NAMES,
  UpdateCaseFactOutputSchema,
  callTranscriptUri,
  caseUri,
  TranscriptResourceSchema,
  type AutoplayScenario,
  type CallLine,
  type CallState,
  type CallStatusOutput,
  type CaseView,
  type LlmMessage,
  type LlmToolSpec,
  type SimConfig,
} from '@standin/core';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AUTOPLAY_SCRIPTS,
  autoAnswerElicitation,
  autoAnswerPending,
  handoffResponse,
  runAutoplay,
  type AutoplayWorld,
  type ElicitValue,
} from './autoplay.js';
import { forgetToken, loadConfig, resolveToken, storeToken, stripTokenFromUrl, type TokenSource } from './config.js';
import { toCallToolResult, type CallToolResultLike } from './card-bridge.js';
import { connectMcp, isSessionLost, toLlmToolSpecs, type ElicitationRequest, type McpSession, type ToolCallOutcome } from './mcp.js';
import { mergeLines, voiceForSpeaker } from './lines.js';
import { isCallLost, lostCallStatus } from './lost-call.js';
import { createLlmClient, runTurn, type LlmFn } from './orchestrator.js';
import { maskText } from './redact.js';
import { Speaker } from './speech.js';
import { TraceRecorder } from './trace.js';

export type Phase = 'loading' | 'need_token' | 'connecting' | 'ready' | 'error';

export interface ChatLine {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface PendingElicitation {
  id: number;
  request: ElicitationRequest;
  /** Values typed by autoplay, shown in the form before it submits. */
  autofill?: Record<string, ElicitValue>;
}

export interface ActiveCall {
  callId: string;
  caseId: string;
  status?: CallStatusOutput;
  /** performance.now() of the last status. */
  polledAt: number;
}

export interface SimState {
  phase: Phase;
  error?: string;
  config?: SimConfig;
  tokenSource?: TokenSource;
  busy: boolean;
  draft: string;
  listening: boolean;
  chat: ChatLine[];
  caseView?: CaseView;
  caseReady: boolean;
  /** Latest open_case / update_case_fact result (masked), forwarded to the MCP App card. */
  caseResult?: CallToolResultLike;
  call?: ActiveCall;
  callsStarted: number;
  phoneLines: CallLine[];
  elicitation?: PendingElicitation;
  banner?: string;
  autoplay?: AutoplayScenario;
  autoplayLog: string[];
  cardHtml?: string;
  muted: boolean;
  notice?: string;
  /** Bumped when the MCP session is replaced after the server lost it. */
  sessionEpoch: number;
}

const POLL_MS = 1000;

export class SimController {
  readonly recorder = new TraceRecorder();
  #state: SimState = {
    phase: 'loading',
    busy: false,
    draft: '',
    listening: false,
    chat: [],
    caseReady: false,
    callsStarted: 0,
    phoneLines: [],
    autoplayLog: [],
    muted: false,
    sessionEpoch: 0,
  };
  readonly #listeners = new Set<() => void>();
  #token: string | undefined;
  #session: McpSession | undefined;
  #tools: LlmToolSpec[] = [];
  #llm: LlmFn | undefined;
  #speaker: Speaker = new Speaker('browser', () => undefined);
  #history: LlmMessage[] = [];
  #pollTimer: number | undefined;
  #polling = false;
  /** Consecutive call_status tool errors for the current call. */
  #pollErrors = 0;
  #elicitResolve: ((r: ElicitResult) => void) | undefined;
  #elicitSeq = 0;
  #autoplayAbort: AbortController | undefined;
  #timers = new Set<number>();
  #announcedHandoff = new Set<string>();
  #announcedEnd = new Set<string>();
  #autoAnswered = new Set<string>();
  #seenCalls = new Set<string>();

  constructor(autoplay: AutoplayScenario | undefined) {
    if (autoplay !== undefined) this.#state = { ...this.#state, autoplay };
  }

  /* -------------------------- store plumbing -------------------------- */

  getState = (): SimState => this.#state;

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => {
      this.#listeners.delete(l);
    };
  };

  #set(patch: Partial<SimState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l();
  }

  get session(): McpSession | undefined {
    return this.#session;
  }

  /**
   * Stable facade for the MCP App card bridge: every call goes through the
   * current session and survives a reconnect (server restart / idle sweep).
   */
  readonly cardSession: Pick<McpSession, 'callTool' | 'readResource'> = {
    callTool: (name, args) => this.#withSession((s) => s.callTool(name, args)),
    readResource: (uri) => this.#withSession((s) => s.readResource(uri)),
  };

  /* ---------------------------- reconnect ----------------------------- */

  #reconnecting: Promise<McpSession> | undefined;

  /**
   * Runs an MCP operation on the current session. When the server no longer
   * knows the session (404 / -32001 "Session not found": idle sweep, restart,
   * redeploy), reconnects once with the same token and retries.
   */
  async #withSession<T>(op: (s: McpSession) => Promise<T>): Promise<T> {
    const s = this.#session;
    if (s === undefined) throw new Error('Not connected to the Stand-In server.');
    try {
      return await op(s);
    } catch (err) {
      if (!isSessionLost(err)) throw err;
      return op(await this.#reconnect(s));
    }
  }

  /**
   * A token handed out by /sim/config (hosted demo, or the one-time token of
   * an offline run without .env) can change when the server restarts: fetch
   * it again. Returns true when a different token was obtained.
   */
  async #refreshDemoToken(): Promise<boolean> {
    if (this.#state.tokenSource !== 'demo') return false;
    try {
      const config = await loadConfig();
      const next = config.demoToken;
      if (next === undefined || next === this.#token) return false;
      this.#token = next;
      return true;
    } catch {
      return false;
    }
  }

  #reconnect(stale: McpSession): Promise<McpSession> {
    if (this.#session !== undefined && this.#session !== stale) return Promise.resolve(this.#session);
    this.#reconnecting ??= (async () => {
      try {
        await stale.close();
      } catch {
        // the server already dropped it
      }
      let fresh: McpSession;
      try {
        fresh = await connectMcp(this.#connectOptions(this.#requireToken()));
      } catch (err) {
        if (!/401|unauthori[sz]ed/i.test(errMsg(err)) || !(await this.#refreshDemoToken())) throw err;
        fresh = await connectMcp(this.#connectOptions(this.#requireToken()));
      }
      this.#session = fresh;
      this.#tools = toLlmToolSpecs(fresh.tools);
      const call = this.#state.call;
      const st = call?.status?.state;
      if (call !== undefined && (st === undefined || !TERMINAL_CALL_STATES.includes(st))) {
        void fresh.subscribe(callTranscriptUri(call.callId)).catch(() => undefined);
      }
      this.#set({ sessionEpoch: this.#state.sessionEpoch + 1 });
      return fresh;
    })().finally(() => {
      this.#reconnecting = undefined;
    });
    return this.#reconnecting;
  }

  #requireToken(): string {
    if (this.#token === undefined) throw new Error('Not connected to the Stand-In server.');
    return this.#token;
  }

  #connectOptions(token: string): Parameters<typeof connectMcp>[0] {
    return {
      token,
      recorder: this.recorder,
      onElicit: (req) => this.#onElicit(req),
      onResourceUpdated: (uri) => this.#onResourceUpdated(uri),
    };
  }

  /* ------------------------------ startup ------------------------------ */

  #initStarted = false;

  async init(): Promise<void> {
    if (this.#initStarted) return;
    this.#initStarted = true;
    let config: SimConfig;
    try {
      config = await loadConfig();
    } catch (err) {
      this.#set({ phase: 'error', error: `Cannot reach the Stand-In server (${errMsg(err)}).` });
      return;
    }
    const resolved = resolveToken(config, window.location.search, sessionStore());
    stripTokenFromUrl(window.location, window.history);
    this.#set({ config });
    if (resolved === undefined) {
      this.#set({ phase: 'need_token' });
      return;
    }
    this.#set({ tokenSource: resolved.source });
    await this.#connect(resolved.token);
  }

  async submitToken(token: string): Promise<void> {
    const t = storeToken(sessionStore(), token);
    if (t === undefined) return;
    this.#set({ tokenSource: 'session' });
    await this.#connect(t);
  }

  async #connect(token: string): Promise<void> {
    this.#token = token;
    this.#set({ phase: 'connecting', error: undefined });
    const config = this.#state.config;
    this.#speaker = new Speaker(config?.tts === 'polly' ? 'polly' : 'browser', () => this.#token);
    this.#speaker.setMuted(this.#state.muted);
    // Reads the current token on every call: it can be refreshed after a server restart.
    this.#llm = async (req) => {
      try {
        return await createLlmClient(this.#token ?? token)(req);
      } catch (err) {
        if (!/HTTP 401\b/.test(errMsg(err)) || !(await this.#refreshDemoToken())) throw err;
        return createLlmClient(this.#token ?? token)(req);
      }
    };
    try {
      this.#session = await connectMcp(this.#connectOptions(token));
    } catch (err) {
      const msg = errMsg(err);
      if (/401|unauthori[sz]ed/i.test(msg)) {
        forgetToken(sessionStore());
        this.#token = undefined;
        this.#set({ phase: 'need_token', error: 'That token was not accepted.' });
      } else {
        this.#set({ phase: 'error', error: `MCP connection failed (${msg}).` });
      }
      return;
    }
    this.#tools = toLlmToolSpecs(this.#session.tools);
    let cardHtml: string | undefined;
    try {
      const r = await this.#session.readResource(CALL_CARD_URI);
      const first = r.contents[0];
      if (first !== undefined && 'text' in first) cardHtml = first.text;
    } catch {
      cardHtml = undefined; // native card fallback
    }
    this.#set({ phase: 'ready', ...(cardHtml !== undefined ? { cardHtml } : {}) });
    if (this.#state.autoplay !== undefined) void this.#runAutoplay(this.#state.autoplay);
  }

  /* --------------------------- conversation --------------------------- */

  setDraft(draft: string): void {
    this.#set({ draft });
  }

  setListening(listening: boolean): void {
    this.#set({ listening });
  }

  async submit(text: string): Promise<void> {
    const clean = maskText(text.trim());
    if (clean.length === 0 || this.#state.busy || this.#session === undefined || this.#llm === undefined) return;
    this.#set({ busy: true, draft: '', chat: [...this.#state.chat, { role: 'user', text: clean, at: Date.now() }] });
    try {
      const turn = await runTurn(this.#history, clean, {
        llm: this.#llm,
        tools: this.#tools,
        callTool: (name, args) => this.#withSession((s) => s.callTool(name, args)),
        onToolResult: (call, outcome) => this.#onToolResult(call.name, outcome),
        ...(this.#state.autoplay !== undefined ? { scenarioHint: this.#state.autoplay } : {}),
      });
      this.#history = turn.history;
      this.#say(turn.reply);
    } catch (err) {
      this.#say(`Sorry, something went wrong: ${errMsg(err)}`);
    } finally {
      this.#set({ busy: false });
    }
  }

  #say(text: string): void {
    const clean = maskText(text);
    this.#set({ chat: [...this.#state.chat, { role: 'assistant', text: clean, at: Date.now() }] });
    void this.#speaker.speak(clean, 'alexa');
  }

  #onToolResult(name: string, outcome: ToolCallOutcome): void {
    if (!outcome.ok) return;
    if (name === TOOL_NAMES.openCase || name === TOOL_NAMES.updateCaseFact) {
      const r = (name === TOOL_NAMES.openCase ? OpenCaseOutputSchema : UpdateCaseFactOutputSchema).safeParse(outcome.structured);
      if (r.success) {
        this.#set({
          caseView: r.data.case,
          caseReady: r.data.missingFacts.length === 0 && r.data.case.status === 'ready',
          caseResult: toCallToolResult(outcome),
        });
      }
    } else if (name === TOOL_NAMES.placeCall) {
      const r = PlaceCallOutputSchema.safeParse(outcome.structured);
      if (r.success) this.#startCall(r.data.callId, r.data.caseId);
    } else if (name === TOOL_NAMES.callStatus) {
      const r = CallStatusOutputSchema.safeParse(outcome.structured);
      if (r.success && r.data.callId === this.#state.call?.callId) this.#applyStatus(r.data);
    } else if (name === TOOL_NAMES.scheduleFollowup) {
      const r = ScheduleFollowupOutputSchema.safeParse(outcome.structured);
      if (r.success) void this.#watchForFollowupCall(r.data.job.caseId, r.data.job.runAt);
    } else if (name === TOOL_NAMES.handoffToUser || name === TOOL_NAMES.endCall || name === TOOL_NAMES.sendToCall) {
      void this.pollNow();
    }
  }

  /* ---------------------------- elicitation ---------------------------- */

  #onElicit(request: ElicitationRequest): Promise<ElicitResult> {
    // A new request supersedes an unanswered one.
    this.#elicitResolve?.({ action: 'cancel' });
    const id = ++this.#elicitSeq;
    this.#set({ elicitation: { id, request } });
    void this.#speaker.speak(request.message, 'alexa');
    if (this.#state.autoplay !== undefined) {
      const values = autoAnswerElicitation(request.properties);
      this.#after(1400, () => {
        if (this.#state.elicitation?.id !== id) return;
        if (values === null) {
          this.answerElicitation(id, null);
          return;
        }
        this.#set({ elicitation: { id, request, autofill: values } });
        this.#after(1200, () => this.answerElicitation(id, values));
      });
    }
    return new Promise<ElicitResult>((resolve) => {
      this.#elicitResolve = resolve;
    });
  }

  /** values null = decline. */
  answerElicitation(id: number, values: Record<string, ElicitValue> | null): void {
    if (this.#state.elicitation?.id !== id) return;
    const resolve = this.#elicitResolve;
    this.#elicitResolve = undefined;
    this.#set({ elicitation: undefined });
    resolve?.(values === null ? { action: 'decline' } : { action: 'accept', content: values });
  }

  /* ------------------------------- calls ------------------------------- */

  #startCall(callId: string, caseId: string): void {
    if (this.#state.call?.callId === callId) return;
    this.#seenCalls.add(callId);
    this.#set({
      call: { callId, caseId, polledAt: performance.now() },
      callsStarted: this.#state.callsStarted + 1,
      phoneLines: [],
    });
    void this.#session?.subscribe(callTranscriptUri(callId)).catch(() => undefined);
    this.#stopPolling();
    this.#pollErrors = 0;
    this.#pollTimer = window.setInterval(() => void this.pollNow(), POLL_MS);
    void this.pollNow();
  }

  /**
   * schedule_followup hands the call to the server's follow-up ticker, so no
   * place_call result carries the callId. When the job is due soon, watch the
   * case (get_case) for a call this host has not seen and follow it.
   */
  async #watchForFollowupCall(caseId: string, runAt: string): Promise<void> {
    const dueInMs = Date.parse(runAt) - Date.now();
    if (!Number.isFinite(dueInMs) || dueInMs > 120_000) return;
    const deadline = Date.now() + Math.max(0, dueInMs) + 60_000;
    while (Date.now() < deadline && this.#session !== undefined) {
      try {
        const o = await this.#withSession((s) => s.callTool(TOOL_NAMES.getCase, { caseId }));
        const r = GetCaseOutputSchema.safeParse(o.structured);
        if (r.success) {
          const fresh = r.data.calls.find((c) => !this.#seenCalls.has(c.callId));
          if (fresh !== undefined) {
            this.#startCall(fresh.callId, caseId);
            return;
          }
        }
      } catch {
        // keep watching
      }
      await this.#sleep(1500);
    }
  }

  #stopPolling(): void {
    if (this.#pollTimer !== undefined) window.clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async pollNow(): Promise<void> {
    const call = this.#state.call;
    if (call === undefined || this.#session === undefined || this.#polling) return;
    this.#polling = true;
    try {
      const o = await this.#withSession((s) => s.callTool(TOOL_NAMES.callStatus, { callId: call.callId }));
      if (this.#state.call?.callId !== call.callId) return;
      if (!o.ok) {
        // e.g. not_found after a server restart: stop polling and say so,
        // instead of a card frozen on its last state.
        this.#pollErrors++;
        if (isCallLost(o, this.#pollErrors)) {
          this.#pollErrors = 0;
          this.#applyStatus(lostCallStatus(call.callId, call.caseId, this.#state.call.status));
        }
        return;
      }
      this.#pollErrors = 0;
      const r = CallStatusOutputSchema.safeParse(o.structured);
      if (r.success) this.#applyStatus(r.data);
    } catch {
      // transient; next tick retries
    } finally {
      this.#polling = false;
    }
  }

  #applyStatus(status: CallStatusOutput): void {
    const call = this.#state.call;
    if (call === undefined || call.callId !== status.callId) return;
    const prevState: CallState | undefined = call.status?.state;
    const merged = mergeLines(this.#state.phoneLines, status.lastLines);
    this.#set({ call: { ...call, status, polledAt: performance.now() }, phoneLines: merged.lines });
    if (merged.gap) void this.#refreshTranscript(status.callId);
    for (const line of merged.added) {
      const voice = voiceForSpeaker(line.speaker);
      if (voice !== undefined) void this.#speaker.speak(line.text, voice);
    }

    const business = this.#state.caseView?.businessName ?? 'The business';
    if (status.state === 'HANDOFF_PENDING' && !this.#announcedHandoff.has(status.callId)) {
      this.#announcedHandoff.add(status.callId);
      void this.#speaker.speak(`${business} needs to verify you. Join the call?`, 'alexa');
    }
    if (status.state !== 'HANDOFF_PENDING') this.#announcedHandoff.delete(status.callId);

    if (this.#state.autoplay !== undefined) {
      const pq = status.pendingQuestion;
      // Keyed by id + kind: a 'fact' answer can come back as 'confirm' (needs approve=true).
      const pqKey = pq === undefined ? '' : `${pq.id}:${pq.kind}`;
      if (pq !== undefined && !this.#autoAnswered.has(pqKey)) {
        const a = autoAnswerPending(pq);
        if (a !== null) {
          this.#autoAnswered.add(pqKey);
          this.#after(1800, () => {
            const now = this.#state.call?.status?.pendingQuestion;
            if (now !== undefined && `${now.id}:${now.kind}` === pqKey) void this.answer(a.answer, a.approve);
          });
        }
      }
      const resp = handoffResponse(prevState, status.state);
      if (resp !== null) {
        this.#after(resp.delayMs, () => {
          const now = this.#state.call?.status?.state;
          if (resp.action === 'join' && now === 'HANDOFF_PENDING') void this.handoff(true);
          if (resp.action === 'leave' && now === 'USER_ON_LINE') void this.leave();
        });
      }
    }

    if (TERMINAL_CALL_STATES.includes(status.state)) {
      this.#stopPolling();
      if (!this.#announcedEnd.has(status.callId)) {
        this.#announcedEnd.add(status.callId);
        void this.#refreshTranscript(status.callId);
        this.#say(status.summary);
      }
    }
  }

  async #refreshTranscript(callId: string): Promise<void> {
    if (this.#session === undefined) return;
    try {
      const r = await this.#withSession((s) => s.readResource(callTranscriptUri(callId)));
      const first = r.contents[0];
      if (first === undefined || !('text' in first)) return;
      const t = TranscriptResourceSchema.safeParse(JSON.parse(first.text));
      if (!t.success || this.#state.call?.callId !== callId) return;
      // Rebuild from the full transcript, keeping order; nothing is re-spoken.
      this.#set({ phoneLines: mergeLines([], t.data.lines).lines });
    } catch {
      // transcript is best-effort
    }
  }

  #onResourceUpdated(uri: string): void {
    const call = this.#state.call;
    if (call === undefined) return;
    if (uri === callTranscriptUri(call.callId) || uri === caseUri(call.caseId) || uri.includes(call.callId)) void this.pollNow();
  }

  /** Join (accept) / decline the hand-off; "Take over call" (accept=true) also works while a person is on the line. */
  async handoff(accept: boolean, opts: { quiet?: boolean } = {}): Promise<void> {
    const call = this.#state.call;
    if (call === undefined || this.#session === undefined) return;
    try {
      const o = await this.#withSession((s) => s.callTool(TOOL_NAMES.handoffToUser, { callId: call.callId, accept }));
      const r = HandoffToUserOutputSchema.safeParse(o.structured);
      const ok = o.ok && (!r.success || r.data.ok);
      if (!ok && opts.quiet !== true) this.#notice((r.success ? r.data.message : undefined) ?? o.error ?? 'Hand-off was not possible right now.');
      else if (ok && r.success && r.data.message !== undefined) this.#notice(r.data.message);
    } catch (err) {
      if (opts.quiet !== true) this.#notice(errMsg(err));
    }
    await this.pollNow();
  }

  /**
   * Leave the line / hand back (handoff_to_user accept=false while
   * USER_ON_LINE). The server's simulated account holder also hands back on
   * its own, so this is silent when the server has already moved on.
   */
  async leave(): Promise<void> {
    if (this.#state.call?.status?.state !== 'USER_ON_LINE') return;
    await this.handoff(false, { quiet: true });
  }

  async answer(text: string, approve?: boolean): Promise<void> {
    const call = this.#state.call;
    if (call === undefined || this.#session === undefined || text.trim().length === 0) return;
    try {
      const o = await this.#withSession((s) =>
        s.callTool(TOOL_NAMES.sendToCall, {
          callId: call.callId,
          answer: text.trim(),
          ...(approve === true ? { approve: true } : {}),
        }),
      );
      const msg = typeof o.structured === 'object' && o.structured !== null && 'message' in o.structured ? String(o.structured.message) : undefined;
      if (!o.ok) this.#notice(o.error ?? 'Could not pass that on.');
      else if (msg !== undefined) this.#notice(maskText(msg));
    } catch (err) {
      this.#notice(errMsg(err));
    }
    await this.pollNow();
  }

  async endCall(): Promise<void> {
    const call = this.#state.call;
    if (call === undefined || this.#session === undefined) return;
    try {
      await this.#withSession((s) => s.callTool(TOOL_NAMES.endCall, { callId: call.callId }));
    } catch (err) {
      this.#notice(errMsg(err));
    }
    await this.pollNow();
  }

  #notice(text: string): void {
    this.#set({ notice: maskText(text) });
    this.#after(5000, () => this.#set({ notice: undefined }));
  }

  /* ------------------------------ autoplay ----------------------------- */

  #world(): AutoplayWorld {
    const w: AutoplayWorld = {
      busy: this.#state.busy || this.#state.elicitation !== undefined,
      callsStarted: this.#state.callsStarted,
    };
    const st = this.#state.call?.status?.state;
    if (st !== undefined) w.callState = st;
    else if (this.#state.call !== undefined) w.callState = 'DIALING';
    return w;
  }

  async #runAutoplay(scenario: AutoplayScenario): Promise<void> {
    this.#autoplayAbort?.abort();
    const abort = new AbortController();
    this.#autoplayAbort = abort;
    await runAutoplay(
      AUTOPLAY_SCRIPTS[scenario],
      {
        say: (text) => this.#typeAndSubmit(text, abort.signal),
        banner: (text) => this.#set({ banner: text ?? undefined }),
        sleep: (ms) => this.#sleep(ms),
        world: () => this.#world(),
        log: (line) => this.#set({ autoplayLog: [...this.#state.autoplayLog.slice(-30), line] }),
      },
      abort.signal,
    );
  }

  async #typeAndSubmit(text: string, signal: AbortSignal): Promise<void> {
    for (let i = 1; i <= text.length; i++) {
      if (signal.aborted) return;
      this.#set({ draft: text.slice(0, i) });
      await this.#sleep(i % 3 === 0 ? 45 : 25);
    }
    await this.#sleep(400);
    // Submit without awaiting the whole turn: the script waits on 'idle' itself.
    void this.submit(text);
    await this.#sleep(50);
  }

  /* ------------------------------- misc -------------------------------- */

  setMuted(muted: boolean): void {
    this.#speaker.setMuted(muted);
    this.#set({ muted });
  }

  /** "Reset take": stop everything, end the session and reload to a clean host. */
  async resetTake(): Promise<void> {
    this.#autoplayAbort?.abort();
    this.#speaker.cancel();
    this.#stopPolling();
    for (const t of this.#timers) window.clearTimeout(t);
    this.#timers.clear();
    const call = this.#state.call;
    const st = call?.status?.state;
    if (call !== undefined && this.#session !== undefined && (st === undefined || !TERMINAL_CALL_STATES.includes(st))) {
      try {
        await this.#session.callTool(TOOL_NAMES.endCall, { callId: call.callId });
      } catch {
        // best effort
      }
    }
    try {
      await this.#session?.close();
    } catch {
      // best effort
    }
    this.recorder.clear();
    window.location.reload();
  }

  dispose(): void {
    this.#autoplayAbort?.abort();
    this.#stopPolling();
    for (const t of this.#timers) window.clearTimeout(t);
    this.#timers.clear();
    this.#speaker.cancel();
    void this.#session?.close();
  }

  #after(ms: number, fn: () => void): void {
    const t = window.setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.#after(ms, resolve));
  }
}

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function errMsg(err: unknown): string {
  return maskText(err instanceof Error ? err.message : String(err));
}
