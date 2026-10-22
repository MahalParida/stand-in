/**
 * MCP surface (spec 7): 10 tools, 3 resources, elicitation, resource-updated
 * notifications. One McpServer per Streamable HTTP session; all sessions
 * share one StandinApp.
 *
 * SDK: @modelcontextprotocol/sdk 1.32.1 (McpServer.registerTool /
 * registerResource / ResourceTemplate, Server.elicitInput,
 * Server.sendResourceUpdated). The MCP Apps card follows
 * @modelcontextprotocol/ext-apps 2.0.3 conventions (`_meta.ui.resourceUri`
 * plus the legacy `_meta["ui/resourceUri"]`, MIME `text/html;profile=mcp-app`).
 * ext-apps' own server helpers target the v2 `@modelcontextprotocol/server`
 * McpServer, so they are not used with the v1 SDK here.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type ElicitRequestFormParams,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CALL_CARD_URI,
  CallStatusInputSchema,
  CallStatusOutputSchema,
  CaseResourceSchema,
  EndCallInputSchema,
  EndCallOutputSchema,
  GetCaseInputSchema,
  GetCaseOutputSchema,
  HandoffToUserInputSchema,
  HandoffToUserOutputSchema,
  JSON_MIME,
  ListCasesInputSchema,
  ListCasesOutputSchema,
  MCP_APP_MIME,
  OpenCaseInputSchema,
  OpenCaseOutputSchema,
  PlaceCallInputSchema,
  PlaceCallOutputSchema,
  RESOURCE_TEMPLATES,
  ScheduleFollowupInputSchema,
  ScheduleFollowupOutputSchema,
  SendToCallInputSchema,
  SendToCallOutputSchema,
  TOOL_NAMES,
  TranscriptResourceSchema,
  UpdateCaseFactInputSchema,
  UpdateCaseFactOutputSchema,
  callTranscriptUri,
  caseUri,
  type ToolError,
} from '@standin/core';
import { z } from 'zod';
import { CALL_CARD_HTML } from './card.js';
import { ScenarioNameSchema } from './scenarios.js';
import { ToolFailure, type Elicitor, type StandinApp } from './standin-app.js';

export const SERVER_INFO = { name: 'stand-in', version: '0.1.0' } as const;

/** Tool _meta linking the MCP Apps card (modern + legacy keys, per ext-apps). */
const CARD_META = { ui: { resourceUri: CALL_CARD_URI }, 'ui/resourceUri': CALL_CARD_URI } as const;

export const OpenCaseToolInputSchema = OpenCaseInputSchema.extend({
  /** Sim only: which fake-business behaviour the call meets (default: picked from the goal). */
  scenario: ScenarioNameSchema.optional(),
});

const ELICIT_TIMEOUT_MS = 120_000;
const NOTIFY_COALESCE_MS = 250;

function toolError(err: unknown): ToolError {
  if (err instanceof ToolFailure) return { error: { code: err.code.slice(0, 64), message: err.message.slice(0, 500) || err.code } };
  if (err instanceof z.ZodError) return { error: { code: 'invalid_input', message: 'input failed validation' } };
  // Unknown errors: class name only, never a message that might echo input.
  const name = err instanceof Error ? err.name : 'error';
  return { error: { code: 'internal_error', message: `internal error (${name})` } };
}

async function run<T extends Record<string, unknown>>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    const out = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
  } catch (err) {
    const e = toolError(err);
    // No structuredContent on errors: every tool declares a success-shaped
    // outputSchema, and SDK clients (1.32.1 Client.callTool) validate
    // structuredContent against it even when isError is true, which would turn
    // an honest refusal into a -32602 protocol error. The ToolError JSON goes
    // in the text block instead (spec 7 error shape preserved).
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(e) }] };
  }
}

export interface McpSessionHandle {
  server: McpServer;
  /** URIs this session subscribed to or touched (gets notifications/resources/updated). */
  interested: Set<string>;
  dispose(): void;
}

export function createMcpServer(app: StandinApp): McpSessionHandle {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { resources: { subscribe: true, listChanged: true }, tools: { listChanged: false } },
    instructions:
      'Stand-In places customer-care phone calls for the user. open_case -> (update_case_fact for missing facts) -> place_call -> poll call_status every second. ' +
      'When call_status has pendingQuestion kind "fact", ask the user and pass the answer with send_to_call; kind "handoff" means only the user may answer (OTP etc.): ask "Join the call?" and use handoff_to_user. ' +
      'Never ask the user to tell you an OTP, PIN or password.',
  });
  const interested = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const touchCase = (caseId: string): void => {
    interested.add(caseUri(caseId));
  };
  const touchCall = (caseId: string, callId: string): void => {
    interested.add(caseUri(caseId));
    interested.add(callTranscriptUri(callId));
  };

  const notifyUri = (uri: string): void => {
    if (!interested.has(uri) || timers.has(uri)) return;
    const t = setTimeout(() => {
      timers.delete(uri);
      if (!server.isConnected()) return;
      void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
    }, NOTIFY_COALESCE_MS);
    t.unref?.();
    timers.set(uri, t);
  };
  const unsubscribe = app.onChange((e) => {
    notifyUri(caseUri(e.caseId));
    if (e.callId !== undefined) notifyUri(callTranscriptUri(e.callId));
  });

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    interested.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    interested.delete(req.params.uri);
    return {};
  });

  /* ---------------- tools ---------------- */

  server.registerTool(
    TOOL_NAMES.openCase,
    {
      title: 'Open a case',
      description:
        'Start a case for a customer-care call to an allowlisted business. Pass what the user said as goal, the desired outcome and any facts they gave ' +
        '(e.g. account_number, order_id). Disclosure tiers are assigned by the server. Missing required facts are elicited from the user when the host supports ' +
        'elicitation, otherwise returned in missingFacts: ask the user and call update_case_fact.',
      inputSchema: OpenCaseToolInputSchema,
      outputSchema: OpenCaseOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: CARD_META,
    },
    async (args, extra) =>
      run(async () => {
        const caps = server.server.getClientCapabilities();
        const elicit: Elicitor | undefined =
          caps?.elicitation === undefined
            ? undefined
            : async (missing, business) => {
                const properties: ElicitRequestFormParams['requestedSchema']['properties'] = {};
                for (const m of missing) properties[m.key] = { type: 'string', title: m.label, description: m.prompt, minLength: 1, maxLength: 200 };
                const r = await server.server.elicitInput(
                  {
                    mode: 'form',
                    message: `To call ${business.name} I need: ${missing.map((m) => m.label).join(', ')}.`,
                    requestedSchema: { type: 'object', properties, required: missing.map((m) => m.key) },
                  },
                  { relatedRequestId: extra.requestId, timeout: ELICIT_TIMEOUT_MS, signal: extra.signal },
                );
                if (r.action !== 'accept' || r.content === undefined) return undefined;
                const out: Record<string, string> = {};
                for (const [k, v] of Object.entries(r.content)) if (typeof v === 'string') out[k] = v;
                return out;
              };
        const out = await app.openCase(
          {
            businessName: args.businessName,
            goal: args.goal,
            desiredOutcome: args.desiredOutcome,
            facts: args.facts,
            userName: args.userName,
            scenario: args.scenario,
          },
          elicit,
        );
        touchCase(out.case.id);
        return out;
      }),
  );

  server.registerTool(
    TOOL_NAMES.updateCaseFact,
    {
      title: 'Add or change a case fact',
      description:
        'Add or update one fact on a case (e.g. the account number the user just told you). Set approve=true only when the user explicitly agreed to share a personal detail such as a phone number.',
      inputSchema: UpdateCaseFactInputSchema,
      outputSchema: UpdateCaseFactOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const out = await app.updateCaseFact(args);
        touchCase(out.case.id);
        return out;
      }),
  );

  server.registerTool(
    TOOL_NAMES.placeCall,
    {
      title: 'Place the call',
      description:
        'Dial the business for a ready case. Returns immediately with the callId; the call runs in the background. Poll call_status every second. Only allowlisted numbers are ever dialled.',
      inputSchema: PlaceCallInputSchema,
      outputSchema: PlaceCallOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: CARD_META,
    },
    async (args) =>
      run(async () => {
        const out = await app.placeCall(args);
        touchCall(out.caseId, out.callId);
        return out;
      }),
  );

  server.registerTool(
    TOOL_NAMES.callStatus,
    {
      title: 'Call status',
      description:
        'Live state of a call: state, hold time, last transcript lines (masked), pendingQuestion (something only the user can answer), outcome with ticketId/dueBy, and a speakable summary.',
      inputSchema: CallStatusInputSchema,
      outputSchema: CallStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: CARD_META,
    },
    async (args) =>
      run(async () => {
        const out = await app.callStatus(args.callId);
        touchCall(out.caseId, out.callId);
        return out;
      }),
  );

  server.registerTool(
    TOOL_NAMES.sendToCall,
    {
      title: 'Answer a question on the call',
      description:
        "Pass the user's answer to the business's pending question (pendingQuestion kind 'fact'). If the result says confirmRequired, ask the user for permission and resend with approve=true. Never use this for OTPs or PINs.",
      inputSchema: SendToCallInputSchema,
      outputSchema: SendToCallOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(async () => app.sendToCall(args)),
  );

  server.registerTool(
    TOOL_NAMES.handoffToUser,
    {
      title: 'Join or decline the call',
      description:
        "The 'Echo rings' moment: when call_status is HANDOFF_PENDING only the account holder may answer (e.g. an OTP). accept=true bridges the user onto the line; accept=false tells the business they'll verify later. 'Take over call': accept=true while a person is on the line (state HUMAN) also bridges the user; while the user is on the line (USER_ON_LINE), accept=false hands the call back to Stand-In.",
      inputSchema: HandoffToUserInputSchema,
      outputSchema: HandoffToUserOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: CARD_META,
    },
    async (args) => run(async () => app.handoffToUser(args)),
  );

  server.registerTool(
    TOOL_NAMES.endCall,
    {
      title: 'End the call',
      description: 'Hang up now and return the final outcome (if any).',
      inputSchema: EndCallInputSchema,
      outputSchema: EndCallOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: CARD_META,
    },
    async (args) => run(async () => app.endCall(args.callId)),
  );

  server.registerTool(
    TOOL_NAMES.getCase,
    {
      title: 'Get a case',
      description: 'A case with its calls, promises (ticketId, dueBy), follow-ups and a one-sentence summary. Use for "what happened with my complaint?".',
      inputSchema: GetCaseInputSchema,
      outputSchema: GetCaseOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const out = await app.getCase(args.caseId);
        touchCase(out.case.id);
        return out;
      }),
  );

  server.registerTool(
    TOOL_NAMES.listCases,
    {
      title: 'List cases',
      description: "The user's cases, most recently updated first. Optionally filter by status.",
      inputSchema: ListCasesInputSchema,
      outputSchema: ListCasesOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => run(async () => app.listCases(args)),
  );

  server.registerTool(
    TOOL_NAMES.scheduleFollowup,
    {
      title: 'Schedule a follow-up call',
      description:
        "Schedule a follow-up call that quotes the ticket id if the promise is broken. Default time: the promised date + 1 day (returns the already scheduled job if there is one). Pass 'at' (ISO date-time) to call at a specific time.",
      inputSchema: ScheduleFollowupInputSchema,
      outputSchema: ScheduleFollowupOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const out = await app.scheduleFollowup(args);
        touchCase(out.job.caseId);
        return out;
      }),
  );

  /* ---------------- resources ---------------- */

  const idOf = (v: string | string[] | undefined): string => {
    const s = Array.isArray(v) ? v[0] : v;
    if (s === undefined || s.length === 0) throw new ToolFailure('invalid_input', 'missing id');
    return decodeURIComponent(s);
  };

  server.registerResource(
    'case',
    new ResourceTemplate(RESOURCE_TEMPLATES.case, {
      list: async () => {
        const { cases } = await app.listCases({ limit: 50 });
        return {
          resources: cases.map((c) => ({
            uri: caseUri(c.id),
            name: `case-${c.id}`,
            title: `${c.businessName}: ${c.status}`,
            mimeType: JSON_MIME,
          })),
        };
      },
    }),
    { title: 'Case', description: 'A Stand-In case (never-tier values removed).', mimeType: JSON_MIME },
    async (uri, vars) => {
      const body = CaseResourceSchema.parse(await app.getCase(idOf(vars.id)));
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(body) }] };
    },
  );

  server.registerResource(
    'call-transcript',
    new ResourceTemplate(RESOURCE_TEMPLATES.callTranscript, { list: undefined }),
    { title: 'Call transcript', description: 'Masked transcript of a call (masked at write, masked again on read).', mimeType: JSON_MIME },
    async (uri, vars) => {
      const body = TranscriptResourceSchema.parse(await app.transcript(idOf(vars.id)));
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(body) }] };
    },
  );

  const cardUiMeta = { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } };
  server.registerResource(
    'call-card',
    CALL_CARD_URI,
    { title: 'Stand-In call card', description: 'MCP Apps card: Preparing, Dialing, Menu, On hold, Talking, Needs you, Done.', mimeType: MCP_APP_MIME, _meta: cardUiMeta },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: CALL_CARD_HTML, _meta: cardUiMeta }] }),
  );

  return {
    server,
    interested,
    dispose() {
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
