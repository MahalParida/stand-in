/**
 * MCP trace recorder.
 *
 * The browser MCP client's fetch is wrapped (see {@link createTracingFetch}) so
 * every JSON-RPC message that crosses the Streamable HTTP transport - POSTed
 * requests/notifications/responses, JSON responses and SSE-streamed messages -
 * is recorded with its method, id and latency for the trace panel.
 *
 * Payloads are masked at record time ({@link maskDeep}), so a secret never
 * lands in trace memory. HTTP headers (the Bearer token) are never recorded.
 */
import { z } from 'zod';
import { CallStatusOutputSchema, TOOL_NAMES } from '@standin/core';
import { maskDeep } from './redact.js';

export type TraceDirection = 'out' | 'in';
export type TraceKind = 'request' | 'response' | 'notification' | 'error' | 'http';
export type TraceChipKind = 'blocked_utterance' | 'disclosure' | 'injection';

export interface TraceChip {
  kind: TraceChipKind;
  label: string;
}

export interface TraceEntry {
  seq: number;
  /** ms since the recorder's clock origin. */
  at: number;
  direction: TraceDirection;
  kind: TraceKind;
  method?: string;
  /** Tool name for tools/call requests and their responses. */
  tool?: string;
  id?: string | number;
  latencyMs?: number;
  httpStatus?: number;
  isError?: boolean;
  /** Masked JSON-RPC message. */
  payload: unknown;
  chips: TraceChip[];
}

const IdSchema = z.union([z.string(), z.number()]);
const JsonRpcSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: IdSchema.optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).loose().optional(),
  })
  .loose();
type JsonRpc = z.infer<typeof JsonRpcSchema>;

const ToolCallParamsSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).loose();
const ToolResultSchema = z
  .object({ structuredContent: z.unknown().optional(), isError: z.boolean().optional() })
  .loose();

interface Pending {
  method: string;
  tool?: string;
  at: number;
}

interface CallCounters {
  blocked: number;
  injection: number;
  handoff: boolean;
}

export type TraceListener = () => void;

export interface TraceRecorderOptions {
  now?: () => number;
  maxEntries?: number;
}

export class TraceRecorder {
  readonly #now: () => number;
  readonly #max: number;
  #entries: readonly TraceEntry[] = [];
  #seq = 0;
  /** Pending requests keyed by the direction the request travelled. */
  readonly #pending: Record<TraceDirection, Map<string, Pending>> = { out: new Map(), in: new Map() };
  readonly #counters = new Map<string, CallCounters>();
  readonly #listeners = new Set<TraceListener>();

  constructor(opts: TraceRecorderOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#max = opts.maxEntries ?? 2000;
  }

  now(): number {
    return this.#now();
  }

  /** Immutable snapshot (new array on every change; safe for useSyncExternalStore). */
  entries = (): readonly TraceEntry[] => this.#entries;

  subscribe = (listener: TraceListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  clear(): void {
    this.#entries = [];
    this.#pending.out.clear();
    this.#pending.in.clear();
    this.#counters.clear();
    this.#emit();
  }

  /** Every chip recorded so far, oldest first. */
  chips(): TraceChip[] {
    return this.#entries.flatMap((e) => e.chips);
  }

  /**
   * Record one JSON-RPC message (or a batch array). Non JSON-RPC values are
   * ignored. `at` defaults to now.
   */
  record(direction: TraceDirection, raw: unknown, opts: { at?: number; httpStatus?: number } = {}): void {
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      const parsed = JsonRpcSchema.safeParse(item);
      if (!parsed.success) continue;
      this.#recordOne(direction, parsed.data, opts.at ?? this.#now(), opts.httpStatus);
    }
  }

  /** An HTTP-level failure (401, 404, network error) with no JSON-RPC body. */
  recordHttpError(direction: TraceDirection, httpStatus: number | undefined, message: string, at = this.#now()): void {
    const entry: TraceEntry = {
      seq: ++this.#seq,
      at,
      direction,
      kind: 'error',
      isError: true,
      payload: maskDeep({ http: httpStatus ?? 'network', message }),
      chips: [],
    };
    if (httpStatus !== undefined) entry.httpStatus = httpStatus;
    this.#push(entry);
  }

  #recordOne(direction: TraceDirection, msg: JsonRpc, at: number, httpStatus: number | undefined): void {
    const entry: TraceEntry = {
      seq: ++this.#seq,
      at,
      direction,
      kind: 'notification',
      payload: maskDeep(msg),
      chips: [],
    };
    if (httpStatus !== undefined) entry.httpStatus = httpStatus;

    if (msg.method !== undefined) {
      entry.method = msg.method;
      if (msg.id !== undefined) {
        entry.kind = 'request';
        entry.id = msg.id;
        const pending: Pending = { method: msg.method, at };
        if (msg.method === 'tools/call') {
          const p = ToolCallParamsSchema.safeParse(msg.params);
          if (p.success) {
            pending.tool = p.data.name;
            entry.tool = p.data.name;
          }
        }
        this.#pending[direction].set(String(msg.id), pending);
      } else {
        entry.chips = notificationChips(msg);
      }
    } else if (msg.id !== undefined) {
      // A response travels the opposite way to its request.
      entry.id = msg.id;
      entry.kind = msg.error !== undefined ? 'error' : 'response';
      const reqDir: TraceDirection = direction === 'in' ? 'out' : 'in';
      const pending = this.#pending[reqDir].get(String(msg.id));
      if (pending !== undefined) {
        this.#pending[reqDir].delete(String(msg.id));
        entry.method = pending.method;
        if (pending.tool !== undefined) entry.tool = pending.tool;
        entry.latencyMs = Math.max(0, Math.round(at - pending.at));
      }
      if (msg.error !== undefined) entry.isError = true;
      const result = ToolResultSchema.safeParse(msg.result);
      if (result.success) {
        if (result.data.isError === true) entry.isError = true;
        if (entry.tool !== undefined) entry.chips = this.#toolChips(entry.tool, result.data.structuredContent);
      }
    } else {
      return;
    }
    this.#push(entry);
  }

  /** Red chips from call_status deltas: blocked utterances, injection attempts, disclosure hand-offs. */
  #toolChips(tool: string, structured: unknown): TraceChip[] {
    if (tool !== TOOL_NAMES.callStatus) return [];
    const s = CallStatusOutputSchema.safeParse(structured);
    if (!s.success) return [];
    const st = s.data;
    const prev = this.#counters.get(st.callId) ?? { blocked: 0, injection: 0, handoff: false };
    const chips: TraceChip[] = [];
    if (st.blockedCount > prev.blocked) {
      chips.push({ kind: 'blocked_utterance', label: `blocked_utterance ×${st.blockedCount - prev.blocked}` });
    }
    if (st.injectionCount > prev.injection) {
      chips.push({ kind: 'injection', label: `injection ×${st.injectionCount - prev.injection}` });
    }
    const handoff = st.state === 'HANDOFF_PENDING' || st.pendingQuestion?.kind === 'handoff';
    if (handoff && !prev.handoff) {
      chips.push({ kind: 'disclosure', label: `disclosure: ${st.pendingQuestion?.label ?? 'hand-off'}` });
    }
    this.#counters.set(st.callId, {
      blocked: Math.max(prev.blocked, st.blockedCount),
      injection: Math.max(prev.injection, st.injectionCount),
      handoff,
    });
    return chips;
  }

  #push(entry: TraceEntry): void {
    const next = [...this.#entries, entry];
    this.#entries = next.length > this.#max ? next.slice(next.length - this.#max) : next;
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

const NOTIFICATION_CHIP_PATTERNS: Array<[RegExp, TraceChipKind]> = [
  [/blocked_utterance/i, 'blocked_utterance'],
  [/disclosure_request/i, 'disclosure'],
  [/injection/i, 'injection'],
];

/** Server log/notification messages that mention guard events also get chips. */
function notificationChips(msg: JsonRpc): TraceChip[] {
  if (msg.params === undefined) return [];
  let text: string;
  try {
    text = JSON.stringify(msg.params);
  } catch {
    return [];
  }
  const chips: TraceChip[] = [];
  for (const [re, kind] of NOTIFICATION_CHIP_PATTERNS) {
    if (re.test(text)) chips.push({ kind, label: kind });
  }
  return chips;
}

/* ------------------------------------------------------------------ */
/* SSE parsing                                                         */
/* ------------------------------------------------------------------ */

/** Incremental text/event-stream parser that yields each event's data payload. */
export class SseParser {
  #buf = '';
  #data: string[] = [];

  /** Feed a decoded chunk; returns the data payloads of every completed event. */
  push(chunk: string): string[] {
    this.#buf += chunk;
    const out: string[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.#buf);
      if (m === null) break;
      // A lone trailing "\r" might be the first half of "\r\n": wait for more.
      if (m[0] === '\r' && m.index === this.#buf.length - 1) break;
      const line = this.#buf.slice(0, m.index);
      this.#buf = this.#buf.slice(m.index + m[0].length);
      if (line === '') {
        if (this.#data.length > 0) out.push(this.#data.join('\n'));
        this.#data = [];
      } else if (line.startsWith('data:')) {
        const v = line.slice(5);
        this.#data.push(v.startsWith(' ') ? v.slice(1) : v);
      }
      // id:, event:, retry: and comments are irrelevant to the trace.
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* fetch wrapper                                                       */
/* ------------------------------------------------------------------ */

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Wrap fetch for the MCP transport: records outgoing bodies, JSON responses
 * and SSE streams (via tee, so the transport still reads the original).
 */
export function createTracingFetch(recorder: TraceRecorder, baseFetch: FetchLike = (u, i) => fetch(u, i)): FetchLike {
  return async (url, init) => {
    const body = init?.body;
    if (typeof body === 'string') {
      const parsed = parseJson(body);
      if (parsed !== undefined) recorder.record('out', parsed);
    }
    let res: Response;
    try {
      res = await baseFetch(url, init);
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      if (!aborted) recorder.recordHttpError('out', undefined, err instanceof Error ? err.message : 'network error');
      throw err;
    }
    const status = res.status;
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const method = init?.method ?? 'GET';
      if (!(method === 'GET' && status === 405)) recorder.recordHttpError('in', status, `${method} /mcp -> HTTP ${status}`);
      return res;
    }
    if (ctype.includes('application/json')) {
      const text = await res.clone().text();
      const parsed = parseJson(text);
      if (parsed !== undefined) recorder.record('in', parsed, { httpStatus: status });
      return res;
    }
    if (ctype.includes('text/event-stream') && res.body !== null) {
      const [forTransport, forTrace] = res.body.tee();
      void consumeSse(forTrace, recorder, status);
      return new Response(forTransport, { status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
}

async function consumeSse(stream: ReadableStream<Uint8Array>, recorder: TraceRecorder, status: number): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const data of parser.push(decoder.decode(value, { stream: true }))) {
        const parsed = parseJson(data);
        if (parsed !== undefined) recorder.record('in', parsed, { httpStatus: status });
      }
    }
  } catch {
    // Stream aborted (session closed / page reset): nothing more to trace.
  } finally {
    reader.releaseLock();
  }
}
