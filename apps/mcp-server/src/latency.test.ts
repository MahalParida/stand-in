/**
 * Alexa+ requires MCP round trips under 500 ms. Typical tool calls against the
 * local server (offline providers, real HTTP, real MCP client) must be well
 * under that budget.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { callOk, connectClient, startServer, type Started } from './test-helpers.js';

const BUDGET_MS = 500;
const FACTS = [
  { key: 'account_number', value: 'BN7781234' },
  { key: 'registered_phone', value: '+91 98450 12345' },
];

let started: Started | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
});

async function timed(client: Client, name: string, args: Record<string, unknown>): Promise<{ ms: number; out: Record<string, unknown> }> {
  const t0 = performance.now();
  const out = await callOk(client, name, args);
  return { ms: performance.now() - t0, out };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

describe('tool round-trip latency', () => {
  it('open_case, get_case and call_status complete well under 500 ms', async () => {
    started = await startServer();
    const { client } = await connectClient(started.url);
    const samples: Record<string, number[]> = { open_case: [], get_case: [], call_status: [] };
    // Warm-up (JIT, first SQLite statements) is not what Alexa sees on a running server.
    const warm = await timed(client, 'open_case', { businessName: 'BharatNet', goal: 'broadband down', desiredOutcome: 'refund', facts: FACTS });
    const caseId = (warm.out.case as { id: string }).id;
    const callId = (await callOk(client, 'place_call', { caseId })).callId as string;
    for (let i = 0; i < 10; i++) {
      samples.open_case?.push((await timed(client, 'open_case', { businessName: 'BharatNet', goal: `outage ${i}`, desiredOutcome: 'refund', facts: FACTS })).ms);
      samples.get_case?.push((await timed(client, 'get_case', { caseId })).ms);
      samples.call_status?.push((await timed(client, 'call_status', { callId })).ms);
    }
    for (const [name, xs] of Object.entries(samples)) {
      expect(Math.max(...xs), `${name} max`).toBeLessThan(BUDGET_MS);
      expect(median(xs), `${name} median`).toBeLessThan(BUDGET_MS / 5);
    }
    await callOk(client, 'end_call', { callId }).catch(() => undefined);
    await client.close();
  });
});
