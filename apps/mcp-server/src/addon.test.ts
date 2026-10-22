/**
 * Alexa+ add-on listing: /privacy and /terms, the generated PNG media served at
 * /addon-assets/*, and scripts/render-addon.mjs (every manifest URL resolves on
 * the server, PRM resource == manifest endpoint).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type Started } from './test-helpers.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RENDER = join(ROOT, 'scripts', 'render-addon.mjs');
const GEN = join(ROOT, 'apps', 'mcp-server', 'scripts', 'gen-addon-assets.mjs');

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});
async function server(env: Record<string, string> = {}): Promise<Started> {
  const s = await startServer(env);
  started.push(s);
  return s;
}

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface Manifest {
  manifestVersion: string;
  accountLinking?: { enabled: boolean };
  storeListing: {
    distributionCountries: string[];
    locales: Record<
      string,
      {
        name: { value: string };
        shortDescription: string;
        examplePhrases: string[];
        privacyAndCompliance: { privacyPolicyUrl: string; termsOfUseUrl: string };
        mediaAssets: { icons: { light: { size: string; uri: string }[] }; carouselImages: { size: string; uri: string; altText: string }[] };
      }
    >;
  };
  integrations: { type: string; config: { endpoints: { default: { type: string; uri: string } } } }[];
}

function render(baseUrl: string, out: string): Manifest {
  execFileSync(process.execPath, [RENDER, '--base-url', baseUrl, '--out', out], { stdio: 'pipe', env: { PATH: process.env.PATH ?? '' } });
  return JSON.parse(readFileSync(out, 'utf8')) as Manifest;
}

describe('/privacy and /terms', () => {
  it('serve self-contained HTML that states retention, masking, deletion and no real calls', async () => {
    const s = await server({ TRANSCRIPT_TTL_DAYS: '30' });
    for (const path of ['/privacy', '/terms']) {
      const r = await fetch(`${s.url}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^text\/html/);
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await r.text();
      expect(html).not.toMatch(/<script|https?:\/\/(?!127\.0\.0\.1)[^"'\s<]+\.(js|css)/i);
      expect(html).toMatch(/30[- ]day/);
      expect(html).toMatch(/simulated/i);
    }
    const privacy = await (await fetch(`${s.url}/privacy`)).text();
    expect(privacy).toMatch(/masked/i);
    expect(privacy).toContain('delete_case');
  });
});

describe('/addon-assets', () => {
  it('serves every icon size and the 600x900 carousel as image/png with the right dimensions', async () => {
    const s = await server();
    const files: [string, number, number][] = [
      ...[72, 64, 88, 126, 180, 241].map((n): [string, number, number] => [`icon-${n}x${n}.png`, n, n]),
      ['carousel-600x900.png', 600, 900],
    ];
    for (const [name, w, h] of files) {
      const r = await fetch(`${s.url}/addon-assets/${name}`);
      expect(r.status, name).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(pngSize(Buffer.from(await r.arrayBuffer()))).toEqual({ width: w, height: h });
    }
    for (const bad of ['/addon-assets/../package.json', '/addon-assets/nope.png', '/addon-assets/icon-72x72.svg', '/addon-assets/%2e%2e%2fpackage.json']) {
      const r = await fetch(`${s.url}${bad}`);
      expect(r.status, bad).toBe(404);
      await r.text();
    }
  });

  it('the generator is deterministic and matches the committed files', () => {
    const out = mkdtempSync(join(tmpdir(), 'standin-assets-'));
    execFileSync(process.execPath, [GEN, out], { stdio: 'pipe' });
    const committed = fileURLToPath(new URL('../assets/', import.meta.url));
    for (const name of ['icon-72x72.png', 'icon-241x241.png', 'carousel-600x900.png']) {
      const a = readFileSync(join(out, name));
      const b = readFileSync(join(committed, name));
      // Compare dimensions only: other zlib builds may compress the same pixels to different bytes.
      expect(pngSize(a)).toEqual(pngSize(b));
    }
    const again = mkdtempSync(join(tmpdir(), 'standin-assets-'));
    execFileSync(process.execPath, [GEN, again], { stdio: 'pipe' });
    expect(readFileSync(join(again, 'carousel-600x900.png'))).toEqual(readFileSync(join(out, 'carousel-600x900.png')));
  });
});

describe('scripts/render-addon.mjs', () => {
  it('fills PUBLIC_BASE_URL and meets the documented field constraints', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'standin-addon-')), 'addon.json');
    const m = render('https://standin.example.com/', out);
    expect(m.manifestVersion).toBe('1.0');
    expect(m.storeListing.distributionCountries).toEqual(['US']);
    expect(m.accountLinking).toEqual({ enabled: true });
    const l = m.storeListing.locales['en-US'];
    expect(l).toBeDefined();
    if (l === undefined) return;
    expect(l.name.value).toBe('Stand-In');
    expect(l.shortDescription.length).toBeLessThanOrEqual(123);
    expect(l.examplePhrases.length).toBeGreaterThanOrEqual(3);
    expect(l.examplePhrases.length).toBeLessThanOrEqual(4);
    expect(l.examplePhrases).toContain('Ask Stand-In to call BharatNet about my broadband outage');
    expect(l.privacyAndCompliance).toEqual({ privacyPolicyUrl: 'https://standin.example.com/privacy', termsOfUseUrl: 'https://standin.example.com/terms' });
    expect(l.mediaAssets.icons.light.map((i) => i.size).sort()).toEqual(['126x126', '180x180', '241x241', '64x64', '72x72', '88x88']);
    expect(m.integrations[0]?.config.endpoints.default).toEqual({ type: 'HTTPS', uri: 'https://standin.example.com/mcp' });
    expect(readFileSync(out, 'utf8')).not.toContain('${');
  });

  it('keeps fields an existing (CLI-scaffolded) addon.json has', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'standin-addon-')), 'addon.json');
    writeFileSync(out, JSON.stringify({ manifestVersion: '1.0', someCliField: { id: 'keep-me' }, accountLinking: { enabled: true, extra: 1 } }));
    const m = render('https://standin.example.com', out) as Manifest & { someCliField?: unknown; accountLinking?: Record<string, unknown> };
    expect(m.someCliField).toEqual({ id: 'keep-me' });
    expect(m.accountLinking).toEqual({ enabled: true, extra: 1 });
  });

  it('refuses a non-https base URL', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'standin-addon-')), 'addon.json');
    expect(() => render('http://standin.example.com', out)).toThrow();
  });

  it('every manifest URL is served by the server, and the PRM resource equals the manifest endpoint', async () => {
    const base = 'https://standin.example.com';
    const s = await server({ PUBLIC_BASE_URL: base });
    const m = render(base, join(mkdtempSync(join(tmpdir(), 'standin-addon-')), 'addon.json'));
    const l = m.storeListing.locales['en-US'];
    if (l === undefined) throw new Error('no en-US locale');
    const urls = [l.privacyAndCompliance.privacyPolicyUrl, l.privacyAndCompliance.termsOfUseUrl, ...l.mediaAssets.icons.light.map((i) => i.uri), ...l.mediaAssets.carouselImages.map((c) => c.uri)];
    for (const u of urls) {
      const path = new URL(u).pathname;
      const r = await fetch(`${s.url}${path}`);
      expect(r.status, path).toBe(200);
      await r.arrayBuffer();
    }
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json()) as { resource: string };
    expect(prm.resource).toBe(m.integrations[0]?.config.endpoints.default.uri);
  });
});

describe('render-addon --verify: tool discovery before linking', () => {
  interface Discovery {
    problems: string[];
    publicTools: number;
    clientCredentials: boolean;
  }
  type CheckDiscovery = (endpoint: string, asMetadata: unknown) => Promise<Discovery>;
  const OAUTH = {
    OAUTH_CLIENT_ID: 'alexa-standin-test',
    OAUTH_CLIENT_SECRET: 'test-client-secret-0123456789abcdef',
    OAUTH_REDIRECT_URIS: 'https://alexa.amazon.com/api/skill/link/M3TESTVENDOR',
  };
  const check = async (env: Record<string, string>): Promise<Discovery> => {
    const mod = (await import(pathToFileURL(RENDER).href)) as { checkDiscovery: CheckDiscovery };
    const s = await server({ ...OAUTH, ...env });
    const meta: unknown = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json();
    return mod.checkDiscovery(`${s.url}/mcp`, meta);
  };

  it('flags a server Alexa+ cannot discover tools on (both switches off)', async () => {
    const d = await check({});
    expect(d.publicTools).toBe(0);
    expect(d.clientCredentials).toBe(false);
    expect(d.problems.join('\n')).toMatch(/cannot discover tools before linking/);
  });

  it('passes with the documented settings: public discovery + Tier 1 client_credentials', async () => {
    const d = await check({ MCP_PUBLIC_DISCOVERY: 'true', OAUTH_CLIENT_CREDENTIALS: 'true' });
    expect(d.problems).toEqual([]);
    expect(d.publicTools).toBeGreaterThan(0);
    expect(d.clientCredentials).toBe(true);
  });

  it('accepts either switch alone, and tools/call without a token stays 401', async () => {
    expect((await check({ MCP_PUBLIC_DISCOVERY: 'true' })).problems).toEqual([]);
    const tier1 = await check({ OAUTH_CLIENT_CREDENTIALS: 'true' });
    expect(tier1.problems).toEqual([]);
    expect(tier1.publicTools).toBe(0);
  });
});
