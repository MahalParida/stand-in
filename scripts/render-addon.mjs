#!/usr/bin/env node
/**
 * Renders the Alexa+ add-on manifest: fills PUBLIC_BASE_URL into
 * alexa-addon/addon-package/addon.json and validates it against the documented
 * field constraints (MCP QuickStart, addon.json schema reference).
 *
 *   node scripts/render-addon.mjs [--base-url https://...] [--out path] [--verify]
 *
 * PUBLIC_BASE_URL comes from --base-url, else the environment, else the
 * PUBLIC_BASE_URL line of the repo's .env (no other .env value is read).
 * --out defaults to alexa-addon/dist/addon-package/addon.json. When --out
 * already exists (e.g. the addon.json that `alexa-ai new` scaffolded), keys
 * this template does not set are kept, so CLI-written fields survive.
 * --verify fetches every URL in the manifest plus the PRM document and checks
 * that the PRM `resource` equals the manifest's MCP endpoint, that Alexa can
 * discover the tools before any user has linked (an unauthenticated
 * initialize + tools/list succeeds, or the AS offers client_credentials), and
 * that an unauthenticated tools/call gets 401 with no WWW-Authenticate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'alexa-addon', 'addon-package', 'addon.json');
const DEFAULT_OUT = join(ROOT, 'alexa-addon', 'dist', 'addon-package', 'addon.json');
const ICON_SIZES = ['72x72', '64x64', '88x88', '126x126', '180x180', '241x241'];

function die(msg) {
  console.error(`render-addon: error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { baseUrl: undefined, out: DEFAULT_OUT, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a.startsWith('--base-url=')) out.baseUrl = a.slice('--base-url='.length);
    else if (a === '--out') out.out = resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) out.out = resolve(a.slice('--out='.length));
    else if (a === '--verify') out.verify = true;
    else die(`unknown argument ${a}`);
  }
  return out;
}

/** Reads only PUBLIC_BASE_URL from .env (never sources it, never prints other values). */
function baseUrlFromDotenv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*(export\s+)?PUBLIC_BASE_URL=/.test(l))
    .pop();
  if (line === undefined) return undefined;
  const v = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  return v === '' ? undefined : v;
}

export function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('PUBLIC_BASE_URL is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must be https:// (Alexa requires HTTPS for the endpoint and every image)');
  if (u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') throw new Error('PUBLIC_BASE_URL must not have a query, fragment or credentials');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

export function renderAddon(templateText, baseUrl) {
  const filled = templateText.split('${PUBLIC_BASE_URL}').join(baseUrl);
  if (filled.includes('${')) throw new Error('template still has an unfilled ${...} placeholder');
  return JSON.parse(filled);
}

/** Field constraints from the addon.json schema reference. Returns a list of problems. */
export function validateAddon(m) {
  const bad = [];
  const isHttps = (s) => {
    try {
      return new URL(s).protocol === 'https:';
    } catch {
      return false;
    }
  };
  const isImage = (s) => /\.(png|jpe?g|webp)$/i.test(new URL(s).pathname);
  if (m.manifestVersion !== '1.0') bad.push('manifestVersion must be "1.0"');
  const sl = m.storeListing ?? {};
  if (!Array.isArray(sl.distributionCountries) || sl.distributionCountries.length === 0) bad.push('storeListing.distributionCountries is required');
  const locales = Object.entries(sl.locales ?? {});
  if (locales.length === 0) bad.push('storeListing.locales needs at least one locale');
  for (const [loc, l] of locales) {
    const p = `locales.${loc}`;
    const name = l.name?.value ?? '';
    if (name.length === 0 || name.length > 30) bad.push(`${p}.name.value must be 1-30 characters`);
    if (!l.shortDescription || l.shortDescription.length > 123) bad.push(`${p}.shortDescription must be 1-123 characters`);
    if (!l.fullDescription || l.fullDescription.length > 4000) bad.push(`${p}.fullDescription must be 1-4000 characters`);
    const ph = l.examplePhrases ?? [];
    if (ph.length < 3 || ph.length > 4 || ph.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 200)) bad.push(`${p}.examplePhrases must be 3-4 phrases of at most 200 characters`);
    const pc = l.privacyAndCompliance ?? {};
    if (!isHttps(pc.privacyPolicyUrl)) bad.push(`${p}.privacyAndCompliance.privacyPolicyUrl must be https`);
    if (!isHttps(pc.termsOfUseUrl)) bad.push(`${p}.privacyAndCompliance.termsOfUseUrl must be https`);
    const icons = l.mediaAssets?.icons?.light ?? [];
    for (const s of ICON_SIZES) if (!icons.some((i) => i.size === s)) bad.push(`${p}.mediaAssets.icons.light is missing ${s}`);
    for (const i of icons) if (!isHttps(i.uri) || !isImage(i.uri)) bad.push(`${p} icon ${i.size} must be an https PNG/JPG/WEBP`);
    const car = l.mediaAssets?.carouselImages ?? [];
    if (car.length < 1) bad.push(`${p}.mediaAssets.carouselImages needs at least one 600x900 image`);
    for (const c of car) {
      if (c.size !== '600x900' || !isHttps(c.uri) || !isImage(c.uri)) bad.push(`${p} carousel image must be an https 600x900 PNG/JPG/WEBP`);
      if (typeof c.altText !== 'string' || c.altText.length === 0 || c.altText.length > 250) bad.push(`${p} carousel altText must be 1-250 characters`);
    }
  }
  const ints = m.integrations ?? [];
  const mcp = ints.find((i) => i.type === 'MCP');
  const ep = mcp?.config?.endpoints?.default;
  if (ep?.type !== 'HTTPS' || !isHttps(ep?.uri)) bad.push('integrations[MCP].config.endpoints.default must be an HTTPS uri');
  return bad;
}

/** Every URL in the manifest (for --verify). */
export function manifestUrls(m) {
  const urls = new Set();
  for (const l of Object.values(m.storeListing?.locales ?? {})) {
    urls.add(l.privacyAndCompliance?.privacyPolicyUrl);
    urls.add(l.privacyAndCompliance?.termsOfUseUrl);
    for (const i of l.mediaAssets?.icons?.light ?? []) urls.add(i.uri);
    for (const c of l.mediaAssets?.carouselImages ?? []) urls.add(c.uri);
  }
  urls.delete(undefined);
  return [...urls];
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' };

/** A JSON-RPC response from a JSON or SSE body. */
function rpcResult(text) {
  const candidates = text.trim().startsWith('{') ? [text] : text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5));
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c);
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * Pre-deploy discovery checks against the MCP endpoint (no token is sent).
 * Alexa+ reads the tool list during `alexa-ai deploy`, before any user has
 * linked, so either an unauthenticated initialize + tools/list must work
 * (MCP_PUBLIC_DISCOVERY=true) or the AS must offer client_credentials (Tier 1,
 * OAUTH_CLIENT_CREDENTIALS=true). A tools/call without a token must still get
 * 401 with no WWW-Authenticate, which is what starts account linking.
 */
export async function checkDiscovery(endpoint, asMetadata, fetchImpl = fetch) {
  const problems = [];
  const post = async (body, headers = {}) => {
    try {
      const r = await fetchImpl(endpoint, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      return { status: r.status, headers: r.headers, text: await r.text() };
    } catch (err) {
      problems.push(`${endpoint}: ${err instanceof Error ? err.name : 'fetch failed'}`);
      return undefined;
    }
  };
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'render-addon verify', version: '1.0.0' } },
  });
  let publicTools = 0;
  if (init?.status === 200) {
    const sid = init.headers.get('mcp-session-id');
    const session = sid === null ? {} : { 'mcp-session-id': sid };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
    const tools = list?.status === 200 ? rpcResult(list.text)?.result?.tools : undefined;
    publicTools = Array.isArray(tools) ? tools.length : 0;
    if (publicTools === 0) problems.push(`unauthenticated initialize worked but tools/list answered ${list?.status ?? 'nothing'} with no tools`);
  }
  const grants = Array.isArray(asMetadata?.grant_types_supported) ? asMetadata.grant_types_supported : [];
  const tier1 = grants.includes('client_credentials');
  if (publicTools === 0 && !tier1) {
    problems.push(
      'Alexa+ cannot discover tools before linking: an unauthenticated tools/list fails and the AS metadata does not offer client_credentials. Set MCP_PUBLIC_DISCOVERY=true and OAUTH_CLIENT_CREDENTIALS=true (with OAUTH_CLIENT_SECRET) before `alexa-ai deploy`',
    );
  }
  const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cases', arguments: {} } });
  if (call !== undefined) {
    if (call.status !== 401 && call.status !== 403) problems.push(`${endpoint} tools/call without a token answered ${call.status}, expected 401`);
    if (call.headers.get('www-authenticate') !== null) problems.push(`${endpoint} sends WWW-Authenticate on 401 (Alexa+ does not support it)`);
  }
  return { problems, publicTools, clientCredentials: tier1 };
}

async function verify(m, baseUrl) {
  const problems = [];
  const get = async (u) => {
    try {
      return await fetch(u, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      problems.push(`${u}: ${err instanceof Error ? err.name : 'fetch failed'}`);
      return undefined;
    }
  };
  for (const u of manifestUrls(m)) {
    const r = await get(u);
    if (r === undefined) continue;
    await r.arrayBuffer();
    const ct = r.headers.get('content-type') ?? '';
    if (r.status !== 200) problems.push(`${u}: HTTP ${r.status}`);
    else if (/\.png$/.test(new URL(u).pathname) && ct !== 'image/png') problems.push(`${u}: content-type ${ct}`);
  }
  const endpoint = m.integrations.find((i) => i.type === 'MCP').config.endpoints.default.uri;
  let meta = {};
  const prm = await get(`${baseUrl}/.well-known/oauth-protected-resource`);
  if (prm !== undefined) {
    const body = await prm.json().catch(() => ({}));
    if (body.resource !== endpoint) problems.push(`PRM resource ${JSON.stringify(body.resource)} does not equal the manifest endpoint ${endpoint}`);
    const as = await get(`${baseUrl}/.well-known/oauth-authorization-server`);
    meta = as === undefined ? {} : await as.json().catch(() => ({}));
    if (!(meta.code_challenge_methods_supported ?? []).includes('S256')) problems.push('authorization server metadata lacks S256');
    if (body.authorization_servers?.[0] !== meta.issuer) problems.push('PRM authorization_servers[0] does not equal the AS issuer');
  }
  const d = await checkDiscovery(endpoint, meta);
  problems.push(...d.problems);
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.baseUrl ?? process.env.PUBLIC_BASE_URL ?? baseUrlFromDotenv();
  if (raw === undefined || raw === '') die('set PUBLIC_BASE_URL (env, .env or --base-url) to the public https URL of the server');
  let baseUrl;
  let manifest;
  try {
    baseUrl = normalizeBaseUrl(raw);
    manifest = renderAddon(readFileSync(TEMPLATE, 'utf8'), baseUrl);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  const problems = validateAddon(manifest);
  if (problems.length > 0) die(`manifest is invalid:\n  - ${problems.join('\n  - ')}`);
  if (existsSync(args.out)) {
    // Keep fields the CLI scaffolded that this template does not manage.
    const existing = JSON.parse(readFileSync(args.out, 'utf8'));
    manifest = { ...existing, ...manifest, accountLinking: { ...(existing.accountLinking ?? {}), ...manifest.accountLinking } };
  }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  const endpoint = manifest.integrations.find((i) => i.type === 'MCP').config.endpoints.default.uri;
  const shown = relative(process.cwd(), args.out);
  console.log(`render-addon: wrote ${shown.startsWith('..') || shown === '' ? args.out : shown}`);
  console.log(`render-addon: MCP endpoint ${endpoint}`);
  if (args.verify) {
    const issues = await verify(manifest, baseUrl);
    if (issues.length > 0) die(`verification failed:\n  - ${issues.join('\n  - ')}`);
    console.log('render-addon: verified every manifest URL, the PRM resource, tool discovery before linking, and the 401 without WWW-Authenticate on tools/call');
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
