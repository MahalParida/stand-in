import { describe, expect, it } from 'vitest';
import { failureCopy, refusalReason } from './failure-copy.js';
import { FailureReasonSchema } from './types.js';

describe('failureCopy (spec S5: user told honestly)', () => {
  it('has a distinct, specific headline and message for every failure reason', () => {
    const headlines = new Set<string>();
    for (const reason of FailureReasonSchema.options) {
      const c = failureCopy(reason, { businessName: 'BharatNet Broadband' });
      expect(c.headline.length, reason).toBeGreaterThan(3);
      expect(c.message, reason).toMatch(/BharatNet Broadband/);
      headlines.add(c.headline);
    }
    expect(headlines.size).toBe(FailureReasonSchema.options.length);
  });

  it('says whether anything was dialled or confirmed', () => {
    expect(failureCopy('outside_calling_hours').message).toMatch(/09:00 and 20:00 IST.*Nothing was dialled/);
    expect(failureCopy('not_allowlisted').message).toMatch(/vetted directory.*Nothing was dialled/);
    expect(failureCopy('daily_cap_reached').message).toMatch(/Nothing was dialled/);
    expect(failureCopy('call_setup_failed').message).toMatch(/Nothing was dialled/);
    expect(failureCopy('ivr_dead_end', { ivrLoops: 3 }).message).toMatch(/couldn't reach a person.*\(3 loops\).*Nothing was shared/);
    expect(failureCopy('server_restart').message).toMatch(/restarted\. No request was confirmed/);
    expect(failureCopy('carrier_error').message).toMatch(/phone line .* failed/);
  });

  it('maps place_call refusal codes to failure reasons', () => {
    expect(refusalReason('unknown_business')).toBe('not_allowlisted');
    expect(refusalReason('business_opted_out')).toBe('not_allowlisted');
    expect(refusalReason('not_allowlisted')).toBe('not_allowlisted');
    expect(refusalReason('outside_calling_hours')).toBe('outside_calling_hours');
    expect(refusalReason('daily_cap_reached')).toBe('daily_cap_reached');
    expect(refusalReason('call_setup_failed')).toBe('call_setup_failed');
    expect(refusalReason('ivr_dead_end')).toBe('ivr_dead_end');
    expect(refusalReason('case_not_ready')).toBeUndefined();
    expect(refusalReason('internal_error')).toBeUndefined();
  });
});
