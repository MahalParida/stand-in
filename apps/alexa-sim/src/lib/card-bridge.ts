/**
 * MCP Apps host side for ui://standin/call-card.
 *
 * The card HTML runs in a sandboxed srcdoc iframe (allow-scripts only, opaque
 * origin) and speaks the MCP Apps postMessage JSON-RPC protocol (2026-01-26):
 *   view -> host: ui/initialize, ui/notifications/initialized,
 *                 ui/notifications/size-changed, tools/call, resources/read, ping
 *   host -> view: ui/notifications/tool-input, ui/notifications/tool-result,
 *                 ui/notifications/host-context-changed, ui/resource-teardown
 * Method names follow @modelcontextprotocol/ext-apps' spec types. Tool
 * requests are bridged to the host's real MCP client, limited to the
 * call-control tools, so they also show up in the MCP trace.
 */
import { z } from 'zod';
import { TOOL_NAMES, type CallStatusOutput } from '@standin/core';
import type { McpSession, ToolCallOutcome } from './mcp.js';
import { HOST_INFO } from './mcp.js';
import { maskDeep } from './redact.js';

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26' as const;

/** Tools the card may call through the bridge. */
export const CARD_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAMES.callStatus,
  TOOL_NAMES.handoffToUser,
  TOOL_NAMES.sendToCall,
  TOOL_NAMES.endCall,
  TOOL_NAMES.getCase,
  TOOL_NAMES.scheduleFollowup,
]);

const ViewMessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
  })
  .loose();
type ViewMessage = z.infer<typeof ViewMessageSchema>;

const ToolCallParamsSchema = z.object({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).optional() });
const ReadParamsSchema = z.object({ uri: z.string().min(1).max(2000) });
const SizeParamsSchema = z.object({ height: z.number().optional(), width: z.number().optional() }).loose();

export interface CallToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toCallToolResult(o: ToolCallOutcome): CallToolResultLike {
  const out: CallToolResultLike = {
    content: [{ type: 'text', text: o.text.length > 0 ? o.text : JSON.stringify(o.structured ?? {}) }],
  };
  if (o.structured !== null && typeof o.structured === 'object' && !Array.isArray(o.structured)) {
    out.structuredContent = o.structured as Record<string, unknown>;
  }
  if (!o.ok) out.isError = true;
  return out;
}

export interface CardHostDeps {
  session: Pick<McpSession, 'callTool' | 'readResource'>;
  /** Post a message to the view. */
  post(msg: unknown): void;
  theme: 'light' | 'dark';
  callId: string | undefined;
  onInitialized(): void;
  onSize(height: number): void;
  onToolResult?(name: string, outcome: ToolCallOutcome): void;
}

/**
 * Transport-free protocol core (unit-testable): feed it each message from
 * the view; it answers through `deps.post`.
 */
export class CardHost {
  readonly #d: CardHostDeps;
  #ready = false;
  #pending: CallStatusOutput | undefined;
  #pendingCase: CallToolResultLike | undefined;

  constructor(deps: CardHostDeps) {
    this.#d = deps;
  }

  get ready(): boolean {
    return this.#ready;
  }

  async handle(raw: unknown): Promise<void> {
    const parsed = ViewMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.method === undefined) return; // responses to our (none) requests
    const m = parsed.data;
    if (m.id === undefined) {
      this.#notification(m);
      return;
    }
    try {
      const result = await this.#request(m);
      this.#d.post({ jsonrpc: '2.0', id: m.id, result });
    } catch (err) {
      const code = err instanceof MethodNotFound ? -32601 : -32603;
      this.#d.post({ jsonrpc: '2.0', id: m.id, error: { code, message: err instanceof Error ? err.message : 'error' } });
    }
  }

  /**
   * Push an open_case / update_case_fact result ({case, missingFacts}) so the
   * card shows the missing facts / "Case ready" before a call exists (queued
   * until the view is initialised).
   */
  pushCaseResult(result: CallToolResultLike): void {
    this.#pendingCase = result;
    if (this.#ready) this.#sendToolResult(result);
  }

  /** Push the latest call_status to the view (queued until it is initialised). */
  pushStatus(status: CallStatusOutput): void {
    this.#pending = status;
    if (this.#ready) this.#sendStatus(status);
  }

  #notification(m: ViewMessage): void {
    switch (m.method) {
      case 'ui/notifications/initialized':
        this.#ready = true;
        if (this.#d.callId !== undefined) {
          this.#d.post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { callId: this.#d.callId } } });
        }
        if (this.#pendingCase !== undefined) this.#sendToolResult(this.#pendingCase);
        if (this.#pending !== undefined) this.#sendStatus(this.#pending);
        this.#d.onInitialized();
        break;
      case 'ui/notifications/size-changed': {
        const p = SizeParamsSchema.safeParse(m.params);
        if (p.success && typeof p.data.height === 'number' && p.data.height > 0) this.#d.onSize(p.data.height);
        break;
      }
      default:
        break; // logging etc.: ignored
    }
  }

  async #request(m: ViewMessage): Promise<unknown> {
    switch (m.method) {
      case 'ui/initialize':
        return {
          protocolVersion: MCP_APPS_PROTOCOL_VERSION,
          hostInfo: HOST_INFO,
          hostCapabilities: { serverTools: {}, serverResources: {}, logging: {} },
          hostContext: { theme: this.#d.theme, displayMode: 'inline', platform: 'web', locale: 'en-IN', timeZone: 'Asia/Kolkata' },
        };
      case 'ping':
        return {};
      case 'tools/call': {
        const p = ToolCallParamsSchema.safeParse(m.params);
        if (!p.success) throw new Error('invalid tools/call params');
        if (!CARD_ALLOWED_TOOLS.has(p.data.name)) {
          return { content: [{ type: 'text', text: `tool ${p.data.name} is not available to the card` }], isError: true };
        }
        const outcome = await this.#d.session.callTool(p.data.name, { ...(p.data.arguments ?? {}) });
        this.#d.onToolResult?.(p.data.name, outcome);
        return toCallToolResult(outcome);
      }
      case 'resources/read': {
        const p = ReadParamsSchema.safeParse(m.params);
        if (!p.success) throw new Error('invalid resources/read params');
        return await this.#d.session.readResource(p.data.uri);
      }
      default:
        // ui/open-link, ui/message, ui/download-file, ...: not offered by this host.
        throw new MethodNotFound(`${m.method ?? '?'} is not supported by this host`);
    }
  }

  #sendToolResult(result: CallToolResultLike): void {
    const params: CallToolResultLike = { content: result.content };
    if (result.structuredContent !== undefined) params.structuredContent = maskDeep(result.structuredContent) as Record<string, unknown>;
    if (result.isError === true) params.isError = true;
    this.#d.post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params });
  }

  #sendStatus(status: CallStatusOutput): void {
    this.#d.post({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: status.summary }], structuredContent: maskDeep(status) },
    });
  }
}

class MethodNotFound extends Error {}

export interface CardBridgeHandle {
  pushStatus(status: CallStatusOutput): void;
  pushCaseResult(result: CallToolResultLike): void;
  close(): void;
}

export interface CardBridgeOptions {
  iframe: HTMLIFrameElement;
  session: Pick<McpSession, 'callTool' | 'readResource'>;
  callId: string | undefined;
  theme: 'light' | 'dark';
  onInitialized(): void;
  onError(err: Error): void;
  onToolResult?(name: string, outcome: ToolCallOutcome): void;
}

/**
 * Wire a CardHost to the iframe via postMessage. The iframe gets its srcdoc
 * from React (one navigation, even under StrictMode); attach in a layout
 * effect so the listener exists before the card's ui/initialize arrives.
 */
export function attachCardBridge(opts: CardBridgeOptions): CardBridgeHandle {
  const { iframe } = opts;
  const post = (msg: unknown): void => {
    // The sandboxed view has an opaque origin, so '*' is the only target; we
    // only ever accept messages whose source is this iframe's window.
    iframe.contentWindow?.postMessage(msg, '*');
  };
  const host = new CardHost({
    session: opts.session,
    post,
    theme: opts.theme,
    callId: opts.callId,
    onInitialized: opts.onInitialized,
    onSize: (h) => {
      iframe.style.height = `${Math.min(Math.ceil(h), 640)}px`;
    },
    ...(opts.onToolResult !== undefined ? { onToolResult: opts.onToolResult } : {}),
  });
  const listener = (ev: MessageEvent): void => {
    if (ev.source === null || ev.source !== iframe.contentWindow) return;
    host.handle(ev.data).catch((err: unknown) => opts.onError(err instanceof Error ? err : new Error('card bridge error')));
  };
  window.addEventListener('message', listener);
  return {
    pushStatus: (s) => host.pushStatus(s),
    pushCaseResult: (r) => host.pushCaseResult(r),
    close() {
      window.removeEventListener('message', listener);
    },
  };
}
