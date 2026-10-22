/**
 * Tiny glue for a SimCarrier: exposes the fake business as a core `Carrier`
 * (the caller's view of the line), plus a one-call factory for eval/tests.
 */
import type { Carrier, InboundFrame } from '@standin/core';
import { FakeBusiness, type FakeBusinessOptions } from './business.js';
import type { FakeBusinessScenario, FakeBusinessScenarioInput } from './scenario.js';
import { VirtualScheduler, type RunUntilIdleOptions, type RunUntilIdleResult } from './scheduler.js';

/** The caller's end of the line: a core `Carrier` plus the bridged user's voice. */
export interface BusinessLine extends Carrier {
  readonly business: FakeBusiness;
  /** The bridged user speaks to the business directly (never stored or forwarded). */
  userSay(text: string): Promise<void>;
}

/** Wrap a FakeBusiness as a `Carrier`. Every method maps 1:1 onto `business.handle()`. */
export function connect(business: FakeBusiness): BusinessLine {
  return {
    business,
    dial: (number: string, opts: { callId: string }) => business.handle({ type: 'dial', number, callId: opts.callId }),
    say: (text: string, _audio?: Uint8Array) => business.handle({ type: 'say', text }),
    pressDigits: (digits: string) => business.handle({ type: 'dtmf', digits }),
    bridgeUser: () => business.handle({ type: 'bridge_user' }),
    unbridgeUser: () => business.handle({ type: 'unbridge_user' }),
    userSay: (text: string) => business.handle({ type: 'user_say', text }),
    hangup: () => business.handle({ type: 'hangup' }),
    on: (_event: 'frame', cb: (f: InboundFrame) => void) => {
      business.on('frame', cb);
    },
  };
}

export interface SimLine {
  business: FakeBusiness;
  scheduler: VirtualScheduler;
  line: BusinessLine;
  /** Drive the sim until nothing is left to happen (awaits the persona between timers). */
  run(opts?: RunUntilIdleOptions): Promise<RunUntilIdleResult>;
}

/** FakeBusiness on a fresh VirtualScheduler, already wrapped as a line. */
export function createSimLine(
  scenario: FakeBusinessScenarioInput | FakeBusinessScenario,
  opts: Omit<FakeBusinessOptions, 'scheduler'> & { scheduler?: VirtualScheduler } = {},
): SimLine {
  const scheduler = opts.scheduler ?? new VirtualScheduler();
  const business = new FakeBusiness(scenario, { ...opts, scheduler });
  const line = connect(business);
  return {
    business,
    scheduler,
    line,
    run: (runOpts: RunUntilIdleOptions = {}) => {
      const extra = runOpts.settle;
      return scheduler.runUntilIdle({
        ...runOpts,
        settle: async () => {
          await business.settled();
          if (extra) await extra();
        },
      });
    },
  };
}
