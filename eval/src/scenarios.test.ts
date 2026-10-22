import { describe, expect, it } from 'vitest';
import { runChecks } from './checks.js';
import { runScenario } from './runner.js';
import { DEFAULT_SCENARIOS_DIR, listScenarioFiles, loadScenarios } from './scenarios.js';

describe('@standin/eval scenarios', () => {
  it('ships all 8 golden scenarios (spec section 9), each valid', async () => {
    const files = await listScenarioFiles(DEFAULT_SCENARIOS_DIR);
    expect(files).toHaveLength(8);
    const all = await loadScenarios();
    expect(all.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
    const required = all.filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['S1', 'S2', 'S3', 'S5', 'S7', 'S8']);
    expect(all.find((s) => s.id === 'S4')?.user.answers).toBeDefined();
    expect(all.find((s) => s.id === 'S6')?.followup).toBeDefined();
    expect(all.find((s) => s.id === 'S7')?.policyAttempts?.some((a) => a.simulatedHourIst === 23)).toBe(true);
  });

  it('every scenario passes deterministically with the scripted planner, identically across runs', async () => {
    const all = await loadScenarios();
    for (const sc of all) {
      const a = await runScenario(sc, { seed: 1, llm: 'scripted' });
      const checks = runChecks(a);
      expect(checks.filter((c) => !c.pass), `${sc.id} failed`).toEqual([]);
      if (sc.id === 'S1') {
        const b = await runScenario(sc, { seed: 1, llm: 'scripted' });
        const strip = (r: typeof a) => r.calls.map((c) => c.storedEvents.map((e) => e.hash));
        expect(strip(b)).toEqual(strip(a));
      }
    }
  });

  it('promises follow the call date: S1 and S6 still pass on a later demo date (M2 r3 review)', async () => {
    const all = await loadScenarios();
    for (const id of ['S1', 'S6']) {
      const base = all.find((s) => s.id === id);
      if (base === undefined) throw new Error(`${id} missing`);
      const sc = { ...base, clockStart: '2026-11-15T08:30:00Z' };
      const run = await runScenario(sc, { seed: 1, llm: 'scripted' });
      expect(runChecks(run).filter((c) => !c.pass), `${id} on 15 Nov`).toEqual([]);
      const first = run.calls[0];
      expect(first?.snapshot.outcome?.dueBy).toBe('22 Nov 2026');
      const job = first?.finished?.followupJob;
      expect(Date.parse(job?.runAt ?? '')).toBeGreaterThan(Date.parse(first?.finished?.call.endedAt ?? ''));
      if (id === 'S6') expect(run.calls[1]?.snapshot.outcome?.dueBy).toBe('26 Nov 2026');
    }
  });

  it('a promise already in the past fails ended_with_outcome and followup_scheduled', async () => {
    const all = await loadScenarios();
    const base = all.find((s) => s.id === 'S1');
    if (base?.business === undefined) throw new Error('S1 missing');
    const sc = {
      ...base,
      clockStart: '2026-11-15T08:30:00Z',
      business: { ...base.business, overrides: { outcome: { dueBy: '29 Oct 2026' } } },
    };
    const run = await runScenario(sc, { seed: 1, llm: 'scripted' });
    const failed = runChecks(run).filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(['ended_with_outcome', 'followup_scheduled']));
  });
});
