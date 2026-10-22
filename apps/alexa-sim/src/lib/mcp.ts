/**
 * The host's real MCP client: @modelcontextprotocol/sdk Client over
 * StreamableHTTPClientTransport against same-origin /mcp, Bearer auth, with
 * the traced fetch, an elicitation handler and resources/updated handling.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ResourceUpdatedNotificationSchema,
  type CallToolResult,
  type ElicitResult,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SIM_PATHS, ToolErrorSchema, type LlmToolSpec } from '@standin/core';
import { createTracingFetch, type TraceRecorder } from './trace.js';
import { maskDeep, maskText } from './redact.js';

export const HOST_INFO = { name: 'home-hub-sim', version: '0.1.0' } as const;

/** Tool calls can block on a synchronous elicitation; give the user time to answer. */
const TOOL_TIMEOUT_MS = 300_000;

export interface ElicitationRequest {
  message: string;
  /** JSON Schema properties of the requested form. */
  properties: Record<string, ElicitFormProperty>;
  required: string[];
}

export interface ElicitFormProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: Array<{ const: string; title?: string }>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  format?: string;
}

export type ElicitationHandler = (req: ElicitationRequest) => Promise<ElicitResult>;

export interface ToolCallOutcome {
  ok: boolean;
  /** structuredContent (already masked by the server; re-masked here). */
  structured: unknown;
  /** Joined text content blocks (masked). */
  text: string;
  /** Error message when !ok. */
  error?: string;
  /** ToolError code when !ok and the server sent a spec-7 ToolError. */
  errorCode?: string;
  raw: CallToolResult;
}

export interface McpSession {
  client: Client;
  tools: Tool[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  readResource(uri: string): Promise<ReadResourceResult>;
  subscribe(uri: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  token: string;
  recorder: TraceRecorder;
  onElicit: ElicitationHandler;
  onResourceUpdated?: (uri: string) => void;
  origin?: string;
}

export async function connectMcp(opts: ConnectOptions): Promise<McpSession> {
  const origin = opts.origin ?? window.location.origin;
  const transport = new StreamableHTTPClientTransport(new URL(SIM_PATHS.mcp, origin), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
    fetch: createTracingFetch(opts.recorder),
  });
  const client = new Client(HOST_INFO, { capabilities: { elicitation: { form: {} } } });

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params;
    if (!('requestedSchema' in params)) return { action: 'decline' };
    const schema = params.requestedSchema;
    const properties: Record<string, ElicitFormProperty> = {};
    for (const [key, prop] of Object.entries(schema.properties)) properties[key] = toFormProperty(prop);
    return opts.onElicit({ message: maskText(params.message), properties, required: schema.required ?? [] });
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    opts.onResourceUpdated?.(n.params.uri);
  });

  await client.connect(transport);
  const { tools } = await client.listTools();

  const subscribable = client.getServerCapabilities()?.resources?.subscribe === true;

  return {
    client,
    tools,
    async callTool(name, args) {
      const raw = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: TOOL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      });
      return toOutcome(CallToolResultSchema.parse(raw));
    },
    readResource(uri) {
      return client.readResource({ uri });
    },
    async subscribe(uri) {
      if (!subscribable) return;
      await client.subscribeResource({ uri });
    },
    async close() {
      try {
        await transport.terminateSession();
      } catch {
        // server may already have dropped the session
      }
      await client.close();
    },
  };
}

/**
 * True when the server no longer knows this MCP session (idle sweep, restart,
 * redeploy): HTTP 404 / JSON-RPC -32001 "Session not found".
 */
export function isSessionLost(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 404) return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /session not found|-32001/i.test(msg);
}

function toFormProperty(prop: unknown): ElicitFormProperty {
  if (prop === null || typeof prop !== 'object') return {};
  const p = prop as Record<string, unknown>;
  const out: ElicitFormProperty = {};
  if (typeof p.type === 'string') out.type = p.type;
  if (typeof p.title === 'string') out.title = maskText(p.title);
  if (typeof p.description === 'string') out.description = maskText(p.description);
  if (Array.isArray(p.enum)) out.enum = p.enum.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(p.oneOf)) {
    out.oneOf = p.oneOf.flatMap((o: unknown) => {
      if (o === null || typeof o !== 'object') return [];
      const r = o as Record<string, unknown>;
      return typeof r.const === 'string' ? [{ const: r.const, ...(typeof r.title === 'string' ? { title: r.title } : {}) }] : [];
    });
  }
  if (p.default !== undefined) out.default = p.default;
  if (typeof p.minimum === 'number') out.minimum = p.minimum;
  if (typeof p.maximum === 'number') out.maximum = p.maximum;
  if (typeof p.format === 'string') out.format = p.format;
  return out;
}

export function toOutcome(raw: CallToolResult): ToolCallOutcome {
  const text = maskText(
    raw.content
      .flatMap((c) => (c.type === 'text' ? [c.text] : []))
      .join('\n'),
  );
  let structured: unknown = raw.structuredContent === undefined ? undefined : maskDeep(raw.structuredContent);
  const out: ToolCallOutcome = { ok: raw.isError !== true, structured, text, raw };
  if (raw.isError === true) {
    // Servers send the ToolError JSON as text (no structuredContent, so the
    // SDK's outputSchema check does not reject it); accept either form.
    if (structured === undefined) structured = parseJsonText(text);
    const e = ToolErrorSchema.safeParse(structured);
    if (e.success) {
      out.structured = e.data;
      out.errorCode = e.data.error.code;
      out.error = `${e.data.error.code}: ${e.data.error.message}`;
    } else {
      out.error = text || 'tool error';
    }
  }
  return out;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const MAX_TOOL_CONTENT = 19_000;

/** Tool result as the LLM sees it (role 'tool' content). */
export function toolResultForLlm(o: ToolCallOutcome): string {
  const body = o.ok
    ? o.structured !== undefined
      ? JSON.stringify(o.structured)
      : o.text || '{}'
    : toolErrorForLlm(o);
  return body.length > MAX_TOOL_CONTENT ? `${body.slice(0, MAX_TOOL_CONTENT)}…` : body;
}

/**
 * A failed tool as the LLM sees it: always the spec-7 ToolError object
 * {error:{code,message}}, the one contract the server orchestrator parses.
 */
function toolErrorForLlm(o: ToolCallOutcome): string {
  const e = ToolErrorSchema.safeParse(o.structured);
  if (e.success) return JSON.stringify(e.data);
  return toolErrorJson(o.errorCode ?? 'tool_error', o.error ?? o.text);
}

/** Serialise a ToolError ({error:{code,message}}), message masked and clipped. */
export function toolErrorJson(code: string, message: string): string {
  const msg = maskText(message).trim().slice(0, 500) || 'the tool failed';
  return JSON.stringify(ToolErrorSchema.parse({ error: { code: code.slice(0, 64) || 'tool_error', message: msg } }));
}

/** MCP tools -> LLM tool specs (inputSchema = the tool's JSON Schema). */
export function toLlmToolSpecs(tools: readonly Tool[]): LlmToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? t.title ?? t.name).slice(0, 4000),
    inputSchema: { ...t.inputSchema },
  }));
}
