// Authenticated MCP initialize + tools/list against a live Stand-In endpoint,
// using the SDK client installed for apps/mcp-server. Reads SMOKE_URL and
// SMOKE_TOKEN from the environment (never argv); never prints the token.
import { createRequire } from 'node:module';

const url = process.env.SMOKE_URL;
const token = process.env.SMOKE_TOKEN;
if (!url || !token) {
  console.error('smoke-mcp: SMOKE_URL and SMOKE_TOKEN are required');
  process.exit(2);
}

const require = createRequire(new URL('../apps/mcp-server/package.json', import.meta.url));
let Client;
let StreamableHTTPClientTransport;
try {
  ({ Client } = require('@modelcontextprotocol/sdk/client/index.js'));
  ({ StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js'));
} catch {
  console.error('smoke-mcp: @modelcontextprotocol/sdk not found; run `pnpm install` first');
  process.exit(2);
}

const EXPECTED = ['open_case', 'place_call', 'call_status', 'send_to_call', 'handoff_to_user', 'end_call', 'get_case', 'list_cases'];

const transport = new StreamableHTTPClientTransport(new URL('/mcp', url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'stand-in-smoke', version: '0.0.0' });
const timer = setTimeout(() => {
  console.error('smoke-mcp: timed out');
  process.exit(1);
}, 30_000);

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const missing = EXPECTED.filter((n) => !names.includes(n));
  console.log(`smoke-mcp: server ${info?.name ?? '?'} ${info?.version ?? '?'}, ${names.length} tools: ${names.join(', ')}`);
  if (missing.length > 0) {
    console.error(`smoke-mcp: missing tools: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`smoke-mcp: ${err instanceof Error ? `${err.name}: ${err.message}` : 'error'}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => undefined);
}
