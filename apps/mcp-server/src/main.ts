/**
 * Start script: `pnpm --filter @standin/mcp-server start` (loads ../../.env via
 * node --env-file-if-exists). Root `pnpm demo` builds alexa-sim first and runs
 * this with STANDIN_MODE=offline.
 *
 * Never prints STANDIN_TOKEN or any other secret value.
 */
import { createProviders, ProvidersConfigError } from '@standin/providers';
import { parseServerEnv, ServerConfigError } from './config.js';
import { createStandinServer } from './http.js';

/** `KEY=` lines in .env arrive as '': drop them so SDKs (e.g. AWS_PROFILE) treat them as unset. */
function dropBlankEnv(env: NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.trim() === '') delete env[k];
}

/**
 * `--mode=offline|aws` overrides STANDIN_MODE and `--daily-cap=N` sets
 * STANDIN_DAILY_CALL_CAP unless the environment already set it (used by the
 * root `pnpm demo`, cross-platform).
 */
function applyArgs(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  for (const a of argv) {
    const m = /^--mode=(offline|aws)$/.exec(a);
    if (m?.[1] !== undefined) env.STANDIN_MODE = m[1];
    const c = /^--daily-cap=(\d{1,5})$/.exec(a);
    if (c?.[1] !== undefined && env.STANDIN_DAILY_CALL_CAP === undefined) env.STANDIN_DAILY_CALL_CAP = c[1];
  }
}

async function main(): Promise<void> {
  dropBlankEnv(process.env);
  applyArgs(process.argv.slice(2), process.env);
  let env;
  let providers;
  try {
    providers = createProviders(process.env);
    // A clean clone has no .env: the offline loopback demo still starts (one-time token, never printed).
    env = parseServerEnv(process.env, { allowEphemeralToken: providers.mode === 'offline' });
  } catch (err) {
    if (err instanceof ServerConfigError || err instanceof ProvidersConfigError) {
      console.error(`stand-in: ${err.message}. Set them in .env (see .env.example).`);
      process.exit(1);
    }
    throw err;
  }
  const server = createStandinServer({ env, providers, log: (l) => console.log(l) });
  const { url } = await server.listen();
  console.log(
    `stand-in: listening on ${url} (mode=${providers.mode}, llm=${providers.mode === 'aws' ? 'bedrock' : providers.config.STANDIN_LLM}, demoToken=${env.DEMO_EMBED_TOKEN ? 'embedded' : env.STANDIN_TOKEN_EPHEMERAL ? 'one-time, local page only' : 'off'})`,
  );
  console.log(`stand-in: MCP endpoint ${url}/mcp (Bearer token from STANDIN_TOKEN); sim host at ${url}/`);
  if (env.OAUTH_CLIENT_ID !== undefined) {
    // Names and counts only: never the client id's secret, the passcode or any token.
    console.log(
      `stand-in: OAuth account linking on (issuer ${env.PUBLIC_BASE_URL ?? url}, ${env.OAUTH_REDIRECT_URIS.length} redirect URI(s), client ${env.OAUTH_CLIENT_SECRET === undefined ? 'public (PKCE only)' : 'confidential'}, passcode ${env.OAUTH_LINK_PASSCODE === undefined ? 'off' : 'on'})`,
    );
  }
  if (env.STANDIN_TOKEN_EPHEMERAL) {
    console.log(
      'stand-in: STANDIN_TOKEN is not set, so this offline run uses a one-time token that the local sim page receives automatically. Set STANDIN_TOKEN in .env (see .env.example) to connect other MCP clients.',
    );
  }

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`stand-in: ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        providers.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`stand-in: failed to start (${err instanceof Error ? err.name : 'error'}: ${err instanceof Error ? err.message : ''})`);
  process.exit(1);
});
