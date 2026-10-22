/**
 * `pnpm eval` — runs every golden scenario (data/scenarios) deterministically
 * and prints a pass/fail table with per-check details.
 *
 *   --llm scripted|localllm|bedrock   planner backend (default scripted: no LLM, deterministic)
 *   --seeds N                       run each scenario with seeds 1..N (default 1)
 *   --scenario ID                   run only this scenario (e.g. S2); repeatable / comma-separated
 *
 * Exit code is non-zero if any of S1, S2, S3, S5, S7, S8 fail (any seed).
 */
import type { LlmProvider } from '@standin/core';
import { ProvidersConfigError, createLlm, parseProvidersEnv } from '@standin/providers';
import { z } from 'zod';
import { runChecks, type CheckResult } from './checks.js';
import { runScenario, type LlmMode } from './runner.js';
import { loadScenarios, type Scenario } from './scenarios.js';

const ArgsSchema = z.object({
  llm: z.enum(['scripted', 'localllm', 'bedrock']).default('scripted'),
  seeds: z.coerce.number().int().min(1).max(50).default(1),
  scenario: z.array(z.string().regex(/^S\d+$/i)).default([]),
  verbose: z.boolean().default(false),
});
type Args = z.infer<typeof ArgsSchema>;

/** The M2 gate. */
export const REQUIRED_IDS = ['S1', 'S2', 'S3', 'S5', 'S7', 'S8'] as const;

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

function makeLlm(mode: LlmMode): LlmProvider | undefined {
  if (mode === 'scripted') return undefined;
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
    console.error('usage: pnpm eval [--llm scripted|localllm|bedrock] [--seeds N] [--scenario S1,S2] [--verbose]');
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

  // Summary table.
  console.log('\n| ID | Scenario | Required | Result | Checks |');
  console.log('|----|----------|----------|--------|--------|');
  let requiredFailed = 0;
  let passedScenarios = 0;
  for (const sc of wanted) {
    const mine = rows.filter((r) => r.scenario.id === sc.id);
    const good = mine.filter((r) => r.pass).length;
    const allGood = good === mine.length;
    const required = (REQUIRED_IDS as readonly string[]).includes(sc.id);
    if (allGood) passedScenarios++;
    if (required && !allGood) requiredFailed++;
    const checks = mine.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0);
    const total = mine.reduce((n, r) => n + r.checks.length, 0);
    const result = args.seeds === 1 ? (allGood ? 'PASS' : 'FAIL') : `${good}/${mine.length} seeds`;
    console.log(`| ${sc.id} | ${sc.name} | ${required ? 'yes' : 'no'} | ${result} | ${checks}/${total} |`);
  }
  console.log(`\n${passedScenarios}/${wanted.length} scenarios passed${requiredFailed > 0 ? ` · ${requiredFailed} REQUIRED scenario(s) failed` : ' · all required scenarios passed'}`);
  return requiredFailed > 0 ? 1 : 0;
}

process.exitCode = await main();
