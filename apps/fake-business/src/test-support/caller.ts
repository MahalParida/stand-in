/**
 * A tiny deterministic stand-in for the call agent, used only by tests: it
 * reacts to frames with fixed lines so whole calls can be driven end to end.
 */
import type { InboundFrame } from '@standin/core';
import { createSimLine, type SimLine } from '../connect.js';
import type { FakeBusinessScenarioInput } from '../scenario.js';
import type { RunUntilIdleResult } from '../scheduler.js';

export type SecretPolicy = 'refuse' | 'handoff' | 'leak' | 'handoff_silent';

export interface CallerPolicy {
  /** Digits to press per menu (matched by prompt prefix). */
  menu?: Record<string, string>;
  secret?: SecretPolicy;
  /** What the caller says when asked an unknown fact: 'wait_then_answer' | 'dont_know'. */
  unknownFact?: 'wait_then_answer' | 'dont_know';
  /** Never say anything once a human answers. */
  silent?: boolean;
  /** Mention the earlier SR id in the opening line (follow-up call). */
  quoteTicket?: string;
  /** Read back the ticket id wrongly first. */
  wrongReadback?: boolean;
  /** Hang up after the business closes; default true. */
  oneShot?: boolean;
  /** The OTP the user reads out when bridged / the caller leaks. */
  otp?: string;
}

export const DEFAULT_MENU: Record<string, string> = {
  'For billing, press 1': '3',
  'Refunds and credits': '2',
};

export interface DriveResult {
  sim: SimLine;
  frames: InboundFrame[];
  said: string[];
  run: RunUntilIdleResult;
}

export async function drive(
  scenario: FakeBusinessScenarioInput,
  policy: CallerPolicy = {},
  opts: { sim?: SimLine; maxSimMs?: number } = {},
): Promise<DriveResult> {
  const sim = opts.sim ?? createSimLine(scenario);
  const { business, line } = sim;
  const inbox: InboundFrame[] = [];
  const frames: InboundFrame[] = [];
  const said: string[] = [];
  const menu = policy.menu ?? DEFAULT_MENU;
  const otp = policy.otp ?? '482913';
  let wrongDone = false;
  let pendingAnswer: string | undefined;

  const unsubscribe = business.on('frame', (f) => {
    inbox.push(f);
    frames.push(f);
  });

  const say = async (text: string): Promise<void> => {
    said.push(text);
    await line.say(text);
  };

  const react = async (f: InboundFrame): Promise<void> => {
    if (f.kind === 'ivr_prompt') {
      for (const [prefix, digits] of Object.entries(menu)) {
        if (f.text.startsWith(prefix)) await line.pressDigits(digits);
      }
      return;
    }
    if (f.kind !== 'speech' || policy.silent) return;
    const t = f.text;
    if (/how (?:may|can) i help/i.test(t)) {
      await say(
        policy.quoteTicket
          ? `Hello, I'm calling on behalf of Asha Rao about service request ${policy.quoteTicket}. The refund promised has not been received.`
          : "Hello, I'm calling on behalf of Asha Rao. Her broadband has been down for three days and she wants a refund.",
      );
      return;
    }
    if (/registered account number/i.test(t)) {
      await say('The account number is BN 7781234.');
      return;
    }
    if (/router serial number/i.test(t)) {
      if (policy.unknownFact === 'dont_know') {
        await say("Sorry, the customer doesn't have that.");
      } else {
        pendingAnswer = 'The router serial number is RT99881.';
        await say('One moment, let me check with the customer.');
      }
      return;
    }
    if (/take your time/i.test(t) && pendingAnswer) {
      const a = pendingAnswer;
      pendingAnswer = undefined;
      await say(a);
      return;
    }
    if (/one-time password|six digit code|read me the code/i.test(t)) {
      const p = policy.secret ?? 'refuse';
      if (p === 'refuse') await say("I'm sorry, I can't share that. They'll call back to verify.");
      else if (p === 'leak') await say(`The code is ${otp}.`);
      else {
        await say("One moment, I'll get the account holder on the line.");
        await line.bridgeUser();
      }
      return;
    }
    if (/account holder\? Please read out/i.test(t)) {
      if (policy.secret === 'handoff_silent') {
        await line.unbridgeUser();
      } else {
        await line.userSay(`It is ${otp.split('').join(' ')}`);
      }
      return;
    }
    if (/that's verified/i.test(t) && business.userBridged) {
      await line.unbridgeUser();
      return;
    }
    if (/any proof/i.test(t)) {
      await say('The earlier complaint number was 55512.');
      return;
    }
    const sr = /service request number is (SR-\d{5})/i.exec(t) ?? /the number is (SR-\d{5})/i.exec(t);
    if (sr?.[1]) {
      if (policy.wrongReadback && !wrongDone) {
        wrongDone = true;
        await say('Just to confirm, the service request number is SR-11111?');
      } else {
        await say(`Just to confirm, the service request number is ${sr[1]}, is that right?`);
      }
      return;
    }
    if (/anything else/i.test(t)) {
      await say('No, thank you. Goodbye.');
      return;
    }
  };

  await line.dial('+91-00000-00001', { callId: 'call-test' });
  const run = await sim.run({
    ...(opts.maxSimMs === undefined ? {} : { maxSimMs: opts.maxSimMs }),
    settle: async () => {
      while (inbox.length > 0) {
        const f = inbox.shift();
        if (f) await react(f);
        await business.settled();
      }
    },
  });
  unsubscribe();
  return { sim, frames, said, run };
}
