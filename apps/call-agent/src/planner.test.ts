import { PlannerOutputSchema, type ChatRequest } from '@standin/core';
import { containsValue } from '@standin/fake-business';
import { INVALID_JSON_OUTPUT, ScriptedLlmProvider } from '@standin/providers';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_UTTERANCE,
  LlmPlanner,
  PLANNER_SYSTEM_PROMPT,
  buildPlannerMessages,
  contextFromMessages,
  fallbackOutput,
  parsePlannerOutput,
  type PlannerContext,
} from './planner.js';
import { GarbageInjectingLlm, createPolicyLlm, scriptedPolicy } from './scripted-policy.js';
import { CARD, OTP, PASSWORD, fact, harness } from './test-support.js';

const HUMAN_CTX: PlannerContext = {
  state: 'HUMAN',
  businessName: 'BharatNet Broadband',
  userName: 'Asha Rao',
  goal: 'broadband down, wants a refund',
  desiredOutcome: 'refund',
  facts: [
    { key: 'account_number', label: 'BharatNet account number', tier: 'confirm', speakable: true },
    { key: 'otp', label: 'OTP', tier: 'never', speakable: false },
  ],
  heard: { kind: 'speech', speaker: 'agent', text: 'Could you tell me the registered account number, please?' },
  transcript: [],
  issueStated: true,
};

describe('parsePlannerOutput (zod at the LLM boundary)', () => {
  it('accepts valid JSON, fenced JSON, and drops nulls / fills a missing reason', () => {
    expect(parsePlannerOutput('{"action":"press","digits":"3","reason":"refunds"}')).toEqual({
      ok: true,
      output: { action: 'press', digits: '3', reason: 'refunds' },
    });
    expect(parsePlannerOutput('```json\n{"action":"wait","reason":"x"}\n```').ok).toBe(true);
    const r = parsePlannerOutput('{"action":"press","digits":3,"utterance":null}');
    expect(r).toEqual({ ok: true, output: { action: 'press', digits: '3', reason: 'unspecified' } });
  });

  it('rejects invalid JSON and schema violations without echoing the raw text', () => {
    const bad = parsePlannerOutput(INVALID_JSON_OUTPUT);
    expect(bad).toMatchObject({ ok: false, code: 'invalid_json' });
    const schema = parsePlannerOutput('{"action":"say","reason":"no utterance 482913"}');
    expect(schema).toMatchObject({ ok: false, code: 'invalid_schema' });
    if (!schema.ok) expect(schema.message).not.toContain('482913');
    expect(parsePlannerOutput('{"action":"fly","reason":"x"}')).toMatchObject({ ok: false, code: 'invalid_schema' });
    expect(parsePlannerOutput('{"action":"press","digits":"12a","reason":"x"}')).toMatchObject({ ok: false });
    expect(parsePlannerOutput('[1,2]')).toMatchObject({ ok: false });
  });
});

describe('LlmPlanner fallback (S8)', () => {
  it('invalid JSON -> safe fallback utterance + error, in HUMAN', async () => {
    const llm = new ScriptedLlmProvider({ script: [{ kind: 'invalid_json' }] });
    const r = await new LlmPlanner(llm).plan(HUMAN_CTX);
    expect(r.output).toEqual({ action: 'say', utterance: FALLBACK_UTTERANCE, reason: 'planner fallback' });
    expect(r.error?.code).toBe('invalid_json');
  });

  it('schema-invalid output -> fallback; in IVR the fallback is wait (never a random press)', async () => {
    const llm = new ScriptedLlmProvider({ script: [{ kind: 'json', value: { action: 'press' } }] });
    const r = await new LlmPlanner(llm).plan({ ...HUMAN_CTX, state: 'IVR', heard: { kind: 'ivr_prompt', text: 'For refunds, press 3.' } });
    expect(r.output).toEqual(fallbackOutput('IVR'));
    expect(r.output.action).toBe('wait');
    expect(r.error?.code).toBe('invalid_schema');
  });

  it('provider failure -> fallback + provider_error, no throw', async () => {
    const llm = new ScriptedLlmProvider({ script: [{ kind: 'error', message: 'Bedrock 503 with secret 482913' }] });
    const r = await new LlmPlanner(llm).plan(HUMAN_CTX);
    expect(r.output.action).toBe('say');
    expect(r.error).toMatchObject({ code: 'provider_error' });
    expect(r.error?.message).not.toContain('482913');
  });

  it('GarbageInjectingLlm corrupts exactly N calls in the chosen states, then delegates', async () => {
    const llm = new GarbageInjectingLlm(createPolicyLlm(), { states: ['HUMAN'], count: 2, kinds: ['invalid_json', 'schema'] });
    const planner = new LlmPlanner(llm);
    const ivr = await planner.plan({ ...HUMAN_CTX, state: 'IVR', heard: { kind: 'ivr_prompt', text: 'For billing, press 1. For refunds, press 3.' } });
    expect(ivr).toEqual({ output: { action: 'press', digits: '3', reason: 'menu option "refunds"' } });
    expect((await planner.plan(HUMAN_CTX)).error?.code).toBe('invalid_json');
    expect((await planner.plan(HUMAN_CTX)).error?.code).toBe('invalid_schema');
    const ok = await planner.plan(HUMAN_CTX);
    expect(ok.error).toBeUndefined();
    expect(ok.output.utterance).toContain('{{fact:account_number}}');
    expect(llm.injected).toBe(2);
  });

  it('a whole call with garbage planner output still completes (no crash)', async () => {
    const llm = new GarbageInjectingLlm(createPolicyLlm(), { states: ['HUMAN', 'WRAP_UP'], count: 3, kinds: ['invalid_json', 'prose', 'throw'] });
    const h = harness('happy-refund', { planner: new LlmPlanner(llm) });
    await h.session.start();
    await h.run();
    expect(h.session.state).toBe('ENDED');
    expect(h.ofType('error').filter((e) => (e.data as { source: string }).source === 'planner')).toHaveLength(3);
    expect(h.saidTexts().some((t) => t.includes(FALLBACK_UTTERANCE))).toBe(true);
  });
});

describe('never-tier values never reach the LLM', () => {
  it('captures every planner request of a full OTP-trap call and finds no never value in it', async () => {
    const facts = [
      fact('account_number', 'BharatNet account number', 'BN7781234'),
      fact('otp', 'OTP sent to registered mobile', OTP),
      fact('card_number', 'credit card number', CARD),
      fact('netbanking_password', 'net banking password', PASSWORD),
    ];
    const llm = createPolicyLlm();
    const h = harness('otp-trap', {
      facts,
      planner: new LlmPlanner(llm),
      // The goal itself mentions the OTP: it must be masked before it is sent.
      kase: { goal: `broadband down for three days; the OTP ${OTP} came by SMS; wants a refund` },
    });
    await h.session.start();
    await h.run(() => h.session.state === 'HANDOFF_PENDING');
    await h.session.declineHandoff();
    await h.run();
    expect(h.session.state).toBe('ENDED');

    const requests: readonly ChatRequest[] = llm.requests;
    expect(requests.length).toBeGreaterThan(3);
    const wire = JSON.stringify(requests);
    for (const v of [OTP, CARD, PASSWORD]) {
      expect(containsValue(wire, v), `never value ${v} sent to the LLM`).toBe(false);
      for (const r of requests) for (const m of r.messages) expect(containsValue(m.content, v)).toBe(false);
    }
    // Facts are sent as references: keys/labels/tiers, never values (not even share-tier ones).
    const ctx = contextFromMessages(requests[0]?.messages ?? []);
    for (const f of ctx?.facts ?? []) expect(Object.keys(f).sort()).toEqual(['key', 'label', 'speakable', 'tier']);
    expect(ctx?.facts).toContainEqual({ key: 'otp', label: 'OTP sent to registered mobile', tier: 'never', speakable: false });
    expect(ctx?.goal).toContain('•••');
  });

  it('buildPlannerMessages carries the system prompt and a context that round-trips', () => {
    const msgs = buildPlannerMessages(HUMAN_CTX);
    expect(msgs[0]).toEqual({ role: 'system', content: PLANNER_SYSTEM_PROMPT });
    expect(contextFromMessages(msgs)).toEqual(HUMAN_CTX);
    expect(contextFromMessages([{ role: 'user', content: 'hello' }])).toBeUndefined();
  });
});

describe('scriptedPolicy', () => {
  it('picks menu digits by goal, never "repeat"', () => {
    const ivr = (text: string, desiredOutcome: PlannerContext['desiredOutcome'] = 'refund') =>
      scriptedPolicy({ ...HUMAN_CTX, state: 'IVR', desiredOutcome, heard: { kind: 'ivr_prompt', text } });
    const main = 'For billing, press 1. For technical support, press 2. For refunds, press 3. To repeat this menu, press 9.';
    expect(ivr(main)).toMatchObject({ action: 'press', digits: '3' });
    expect(ivr(main, 'repair')).toMatchObject({ action: 'press', digits: '2' });
    expect(ivr('Welcome to BharatNet Broadband.')).toMatchObject({ action: 'wait' });
    expect(ivr('To repeat this menu, press 9.')).toMatchObject({ action: 'wait' });
  });

  it('answers asks with speakable fact references only; unknown or never facts -> request_handoff', () => {
    expect(scriptedPolicy(HUMAN_CTX)).toMatchObject({ action: 'say', utterance: 'Sure, the BharatNet account number is {{fact:account_number}}.' });
    const serial = scriptedPolicy({ ...HUMAN_CTX, heard: { kind: 'speech', text: 'Could you tell me the router serial number?' } });
    expect(serial.action).toBe('request_handoff');
    const otp = scriptedPolicy({ ...HUMAN_CTX, heard: { kind: 'speech', text: 'What is the OTP?' } });
    expect(otp.action).toBe('request_handoff');
  });

  it('turns a stated ticket + date into confirm_outcome, and a confirmation in WRAP_UP into end', () => {
    const o = scriptedPolicy({
      ...HUMAN_CTX,
      heard: {
        kind: 'speech',
        text: 'I have raised your request: refund of ₹799. Your service request number is SR-48213, and this will be completed by 29 Oct 2026. My name is Ravi, for your reference.',
      },
    });
    expect(o).toMatchObject({ action: 'confirm_outcome', outcome: { ticketId: 'SR-48213', dueBy: '29 Oct 2026', agentName: 'Ravi', what: 'refund of ₹799' } });
    const pendingOutcome = { ticketId: 'SR-48213', what: 'refund', dueBy: '29 Oct 2026' };
    expect(scriptedPolicy({ ...HUMAN_CTX, state: 'WRAP_UP', pendingOutcome, heard: { kind: 'speech', text: "Yes, that's correct." } }).action).toBe('end');
    expect(
      scriptedPolicy({ ...HUMAN_CTX, state: 'WRAP_UP', pendingOutcome, heard: { kind: 'speech', text: 'No, sorry, the number is SR-48231.' } }),
    ).toMatchObject({ action: 'confirm_outcome', outcome: { ticketId: 'SR-48231' } });
  });

  it('always returns schema-valid output', () => {
    for (const state of ['DIALING', 'IVR', 'HOLD', 'HUMAN', 'HANDOFF_PENDING', 'USER_ON_LINE', 'WRAP_UP'] as const) {
      expect(PlannerOutputSchema.safeParse(scriptedPolicy({ ...HUMAN_CTX, state })).success).toBe(true);
    }
  });
});
