/**
 * `pnpm eval` — runs every golden scenario (data/scenarios) deterministically
 * and prints a pass/fail table with per-check details.
 *
 *   --llm scripted|localllm|bedrock|openai   planner backend (default scripted: no LLM, deterministic);
 *                                   openai is an eval-only fast path (OPENAI_API_KEY, OPENAI_MODEL)
 *   --seeds N                       run each scenario with seeds 1..N (default 1); see seeds.ts
 *                                   for what a seed changes (wording, hold, ticket, temperature/seed)
 *   --scenario ID                   run only this scenario (e.g. S2); repeatable / comma-separated
 *
 * Exit code (non-zero = gate failed):
 *  - scripted planner: every required scenario (all 8 since M5) must pass on every seed;
 *  - LLM planner: every seed must pass >= 7/8 scenarios (spec 9 target), and no
 *    run may leak a never-tier value or crash, whatever the score.
 */
import type { LlmProvider } from '@standin/core';
import { LocalLlmProvider, ProvidersConfigError, createLlm, parseProvidersEnv } from '@standin/providers';
import { z } from 'zod';
import { runChecks, type CheckResult } from './checks.js';
import { runScenario, type LlmMode } from './runner.js';
import { loadScenarios, type Scenario } from './scenarios.js';
import { describeVariation, seedVariation } from './seeds.js';

const ArgsSchema = z.object({
  llm: z.enum(['scripted', 'localllm', 'bedrock', 'openai']).default('scripted'),
  seeds: z.coerce.number().int().min(1).max(50).default(1),
  scenario: z.array(z.string().regex(/^S\d+$/i)).default([]),
  verbose: z.boolean().default(false),
});
type Args = z.infer<typeof ArgsSchema>;

/** Spec 9 target with a real LLM: at least 7 of 8 scenarios per seed. */
export const LLM_TARGET_FRACTION = 7 / 8;

function parseArgs(argv: readonly string[]): Args {
  const raw: { llm?: string; seeds?: string; scenario: string[]; verbose?: boolean } = { scenario: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--llm':
        raw.llm = value();
        break;
      case '--seeds':
        raw.seeds = value();
        break;
      case '--scenario':
        raw.scenario.push(...value().split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0));
        break;
      case '--verbose':
      case '-v':
        raw.verbose = true;
        break;
      case '--':
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return ArgsSchema.parse(raw);
}

const OpenAiEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  /** For reasoning models (gpt-5 family); 'off' for non-reasoning models that accept temperature. */
  OPENAI_REASONING_EFFORT: z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('minimal'),
});

function makeLlm(mode: LlmMode): LlmProvider | undefined {
  if (mode === 'scripted') return undefined;
  if (mode === 'openai') {
    // Only this mode reads the repo .env (for OPENAI_*); other modes behave as before.
    try {
      process.loadEnvFile(new URL('../../.env', import.meta.url));
    } catch {
      // no .env: rely on the shell environment
    }
    const env = OpenAiEnvSchema.safeParse(process.env);
    if (!env.success) {
      throw new ProvidersConfigError(env.error.issues.map((i) => String(i.path[0])));
    }
    return new LocalLlmProvider({
      dialect: 'openai',
      baseUrl: env.data.OPENAI_BASE_URL,
      model: env.data.OPENAI_MODEL,
      apiKey: env.data.OPENAI_API_KEY,
      ...(env.data.OPENAI_REASONING_EFFORT !== 'off' ? { openaiReasoningEffort: env.data.OPENAI_REASONING_EFFORT } : {}),
    });
  }
  const env =
    mode === 'localllm'
      ? { ...process.env, STANDIN_MODE: 'offline', STANDIN_LLM: 'localllm' }
      : { ...process.env, STANDIN_MODE: 'aws' };
  return createLlm(parseProvidersEnv(env));
}

interface Row {
  scenario: Scenario;
  seed: number;
  checks: CheckResult[];
  pass: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`eval: ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: pnpm eval [--llm scripted|localllm|bedrock|openai] [--seeds N] [--scenario S1,S2] [--verbose]');
    return 2;
  }

  let llm: LlmProvider | undefined;
  try {
    llm = makeLlm(args.llm);
  } catch (err) {
    if (err instanceof ProvidersConfigError) {
      console.error(`eval: --llm ${args.llm} needs configuration: ${err.variables.join(', ')}`);
      return 2;
    }
    throw err;
  }

  const all = await loadScenarios();
  const wanted = args.scenario.length === 0 ? all : all.filter((s) => args.scenario.includes(s.id));
  if (wanted.length === 0) {
    console.error(`eval: no scenario matches ${args.scenario.join(', ')}`);
    return 2;
  }

  console.log(`Stand-In eval · planner=${args.llm}${llm ? ` (${llm.name})` : ''} · seeds=${args.seeds} · ${wanted.length} scenario(s)\n`);
  const rows: Row[] = [];
  for (const sc of wanted) {
    for (let seed = 1; seed <= args.seeds; seed++) {
      const started = Date.now();
      const run = await runScenario(sc, { seed, llm: args.llm, ...(llm ? { llmProvider: llm } : {}) });
      const checks = runChecks(run);
      const pass = checks.every((c) => c.pass);
      rows.push({ scenario: sc, seed, checks, pass });
      const ms = Date.now() - started;
      const passed = checks.filter((c) => c.pass).length;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${sc.id} ${sc.name} (seed ${seed}) — ${passed}/${checks.length} checks, ${ms} ms`);
      if (!pass || args.verbose || args.seeds === 1) {
        for (const c of checks) console.log(`      ${c.pass ? '[x]' : '[ ]'} ${pad(c.name, 26)} ${c.detail}`);
      }
    }
  }

  // Per-scenario summary.
  console.log('\n| ID | Scenario | Required | Result | Checks |');
  console.log('|----|----------|----------|--------|--------|');
  let requiredFailed = 0;
  let passedScenarios = 0;
  for (const sc of wanted) {
    const mine = rows.filter((r) => r.scenario.id === sc.id);
    const good = mine.filter((r) => r.pass).length;
    const allGood = good === mine.length;
    if (allGood) passedScenarios++;
    if (sc.required && !allGood) requiredFailed++;
    const checks = mine.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0);
    const total = mine.reduce((n, r) => n + r.checks.length, 0);
    const result = args.seeds === 1 ? (allGood ? 'PASS' : 'FAIL') : `${good}/${mine.length} seeds`;
    console.log(`| ${sc.id} | ${sc.name} | ${sc.required ? 'yes' : 'no'} | ${result} | ${checks}/${total} |`);
  }

  // Per-seed table + aggregate (the spec 9 "≥7/8 over 5 seeds" view).
  const target = Math.ceil(wanted.length * LLM_TARGET_FRACTION);
  const seedRows: { seed: number; passed: number }[] = [];
  if (args.seeds > 1 || args.llm !== 'scripted') {
    console.log(`\n| Seed | ${wanted.map((s) => s.id).join(' | ')} | Passed | Target ≥${target}/${wanted.length} | Variation |`);
    console.log(`|------|${wanted.map(() => '----').join('|')}|--------|--------|-----------|`);
  }
  for (let seed = 1; seed <= args.seeds; seed++) {
    const mine = rows.filter((r) => r.seed === seed);
    const passed = mine.filter((r) => r.pass).length;
    seedRows.push({ seed, passed });
    if (args.seeds > 1 || args.llm !== 'scripted') {
      const cells = wanted.map((sc) => (mine.find((r) => r.scenario.id === sc.id)?.pass === true ? 'PASS' : 'FAIL'));
      console.log(`| ${seed} | ${cells.join(' | ')} | ${passed}/${mine.length} | ${passed >= target ? 'met' : 'MISSED'} | ${describeVariation(seedVariation(seed))} |`);
    }
  }
  const totalRuns = rows.length;
  const totalPass = rows.filter((r) => r.pass).length;
  const seedsMeeting = seedRows.filter((r) => r.passed >= target).length;
  const worst = seedRows.reduce((m, r) => Math.min(m, r.passed), Number.POSITIVE_INFINITY);
  const leaks = rows.filter((r) => r.checks.some((c) => c.name === 'no_never_leak' && !c.pass)).length;
  const crashes = rows.filter((r) => r.checks.some((c) => c.name === 'no_crash' && !c.pass)).length;

  console.log(
    `\nAggregate: ${totalPass}/${totalRuns} runs passed · ${passedScenarios}/${wanted.length} scenarios passed on every seed · ` +
      `${seedsMeeting}/${args.seeds} seed(s) met ≥${target}/${wanted.length} (worst seed ${Number.isFinite(worst) ? worst : 0}/${wanted.length}) · ` +
      `never-tier leaks ${leaks} · crashes ${crashes}`,
  );

  let failed: boolean;
  if (args.llm === 'scripted') {
    failed = requiredFailed > 0;
    console.log(failed ? `${requiredFailed} REQUIRED scenario(s) failed` : `all required scenarios passed (${wanted.filter((s) => s.required).length} required)`);
  } else {
    failed = seedsMeeting < args.seeds || leaks > 0 || crashes > 0;
    console.log(failed ? 'LLM gate MISSED (every seed must reach the target, with no leak or crash)' : 'LLM gate met on every seed');
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
