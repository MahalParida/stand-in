/**
 * Alexa+ keeps no MCP session id per add-on: requests that carry no
 * Mcp-Session-Id (other than initialize) are served statelessly, behind the
 * same authentication.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, TOKEN, type Started } from './test-helpers.js';

let s: Started | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const headers = (token?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
});

async function rpc(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${url}/mcp`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
}

describe('stateless MCP fallback (no Mcp-Session-Id)', () => {
  it('serves tools/list and tools/call without a session, as JSON', async () => {
    s = await startServer();
    const list = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TOKEN);
    expect(list.status).toBe(200);
    expect(list.headers.get('mcp-session-id')).toBeNull();
    const listed = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).toContain('open_case');

    const call = await rpc(
      s.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_cases', arguments: {} } },
      TOKEN,
    );
    expect(call.status).toBe(200);
    const called = (await call.json()) as { result: { isError?: boolean } };
    expect(called.result.isError).not.toBe(true);
  });

  it('still requires authentication: 401 without WWW-Authenticate', async () => {
    s = await startServer();
    const r = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_cases', arguments: {} } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });

  it('an unknown session id is still 404 (no silent stateless fallback)', async () => {
    s = await startServer();
    const r = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { ...headers(TOKEN), 'mcp-session-id': 'not-a-real-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(404);
  });
});
