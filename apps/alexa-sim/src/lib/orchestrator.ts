/**
 * Browser-side orchestrator loop (spec §8): send the conversation + MCP tools
 * to POST /sim/api/llm, execute the returned tool calls over MCP, append the
 * results, repeat until the model answers with text.
 */
import {
  SIM_PATHS,
  SimLlmResponseSchema,
  TOOL_SCHEMAS,
  ToolNameSchema,
  type AutoplayScenario,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolSpec,
  type SimLlmRequest,
  type SimLlmResponse,
} from '@standin/core';
import { maskText } from './redact.js';
import { toolErrorJson, toolResultForLlm, type ToolCallOutcome } from './mcp.js';

export type LlmFn = (req: SimLlmRequest) => Promise<SimLlmResponse>;

export interface OrchestratorDeps {
  llm: LlmFn;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  tools: readonly LlmToolSpec[];
  scenarioHint?: AutoplayScenario;
  /** Observes every executed tool call (place_call -> start polling, etc.). */
  onToolResult?(call: LlmToolCall, outcome: ToolCallOutcome): void;
  maxSteps?: number;
}

export interface TurnResult {
  history: LlmMessage[];
  reply: string;
  toolCalls: number;
}

/** The server bounds what reaches a real model further (sim-guard.ts). */
const MAX_HISTORY = 160;
const FALLBACK_REPLY = "Sorry, I couldn't finish that. Please try again.";

/** Keep the tail of the conversation, cut at a user message so tool pairs stay intact. */
export function trimHistory(history: readonly LlmMessage[], max = MAX_HISTORY): LlmMessage[] {
  if (history.length <= max) return [...history];
  const tail = history.slice(history.length - max);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser <= 0 ? tail : tail.slice(firstUser);
}

export async function runTurn(history: readonly LlmMessage[], userText: string, deps: OrchestratorDeps): Promise<TurnResult> {
  const maxSteps = deps.maxSteps ?? 8;
  const known = new Set(deps.tools.map((t) => t.name));
  let msgs: LlmMessage[] = trimHistory([...history, { role: 'user', content: maskText(userText).slice(0, 20_000) }]);
  let toolCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    const req: SimLlmRequest = { messages: msgs, tools: [...deps.tools] };
    if (deps.scenarioHint !== undefined) req.scenarioHint = deps.scenarioHint;
    const res = await deps.llm(req);
    const calls = res.toolCalls ?? [];
    const text = res.text === undefined ? undefined : maskText(res.text);
    const assistant: LlmMessage = { role: 'assistant', content: text ?? '' };
    if (calls.length > 0) assistant.toolCalls = calls;
    msgs = [...msgs, assistant];
    if (calls.length === 0) {
      return { history: msgs, reply: text ?? FALLBACK_REPLY, toolCalls };
    }
    for (const call of calls) {
      toolCalls++;
      const content = await executeToolCall(call, known, deps);
      msgs = [...msgs, { role: 'tool', toolCallId: call.id, content }];
    }
    msgs = trimHistory(msgs);
  }
  return { history: msgs, reply: FALLBACK_REPLY, toolCalls };
}

async function executeToolCall(call: LlmToolCall, known: ReadonlySet<string>, deps: OrchestratorDeps): Promise<string> {
  if (!known.has(call.name)) return toolErrorJson('unknown_tool', `unknown tool ${call.name}`);
  let args: Record<string, unknown> = call.arguments;
  const name = ToolNameSchema.safeParse(call.name);
  if (name.success) {
    const parsed = TOOL_SCHEMAS[name.data].input.safeParse(call.arguments);
    if (!parsed.success) {
      return toolErrorJson('invalid_input', `invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    args = { ...call.arguments };
  }
  try {
    const outcome = await deps.callTool(call.name, args);
    deps.onToolResult?.(call, outcome);
    return toolResultForLlm(outcome);
  } catch (err) {
    return toolErrorJson('tool_call_failed', err instanceof Error ? err.message : 'tool call failed');
  }
}

/** POST /sim/api/llm with the Bearer token; response validated with zod. */
export function createLlmClient(token: string, fetchImpl: typeof fetch = (u, i) => fetch(u, i)): LlmFn {
  return async (req) => {
    const res = await fetchImpl(SIM_PATHS.llm, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`LLM proxy -> HTTP ${res.status}`);
    return SimLlmResponseSchema.parse(await res.json());
  };
}
