/**
 * Call-placement policy (spec section 4 invariants, section 13 anti-harassment).
 *
 * `place_call` is allowed only if ALL hold:
 *   - case.status === 'ready'
 *   - case.businessId is in the allowlisted directory and not opted out
 *   - the *effective calling time* is within 09:00-20:00 IST (and within the
 *     business's own hours). The effective time is the IST day of
 *     `clock.now()` at hour `opts.simulatedHourIst ?? 14` (interactive / demo
 *     mode, so judges in other time zones are never locked out), or the real
 *     IST wall clock when `opts.strictCallingHours` is true
 *     (STRICT_CALLING_HOURS=true; see `strictCallingHoursFromEnv`).
 *   - the per-business daily cap (IST calendar day) is not reached
 */
import type { Clock } from './interfaces.js';
import type { CallRepo } from './repo-types.js';
import { z } from 'zod';
import { CaseSchema, type Business, type Case } from './types.js';

export const IST_TIMEZONE = 'Asia/Kolkata';
/** Global calling window, IST, [start, end). */
export const CALLING_WINDOW_IST = { start: '09:00', end: '20:00' } as const;

export type PolicyDenyCode =
  | 'invalid_case'
  | 'invalid_options'
  | 'case_not_ready'
  | 'unknown_business'
  | 'business_opted_out'
  | 'outside_calling_hours'
  | 'daily_cap_reached';

export type PolicyDecision =
  | { ok: true; business: Business }
  | { ok: false; code: PolicyDenyCode; message: string };

/** Simulated IST hour used when none is given (spec section 4). */
export const DEFAULT_SIMULATED_HOUR_IST = 14;

export const SimulatedHourIstSchema = z.number().int().min(0).max(23);

export const CallingHoursOptionsSchema = z.object({
  /** Simulated IST hour (0-23) for the calling-hours check; defaults to 14. Ignored in strict mode. */
  simulatedHourIst: SimulatedHourIstSchema.optional(),
  /** Use the real IST wall clock instead of the simulated hour (STRICT_CALLING_HOURS=true). */
  strictCallingHours: z.boolean().optional(),
});
export type CallingHoursOptions = z.infer<typeof CallingHoursOptionsSchema>;

const CanPlaceCallOptionsSchema = CallingHoursOptionsSchema.extend({
  /** Calls already placed to this business during the current IST day (see istDayBounds). */
  callsPlacedToday: z.number().int().min(0).optional(),
});
export type CanPlaceCallOptions = z.infer<typeof CanPlaceCallOptionsSchema>;

/** Reads STRICT_CALLING_HOURS from an env-like record (only the exact string "true" enables it). */
export function strictCallingHoursFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.STRICT_CALLING_HOURS?.trim().toLowerCase() === 'true';
}

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): { ymd: string; minutes: number; hhmm: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hh = Number(parts.hour);
  const mm = Number(parts.minute);
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hh * 60 + mm,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** True if `date` falls in [start, end) local time in `timeZone`. */
export function withinWindow(date: Date, window: { start: string; end: string }, timeZone: string): boolean {
  const { minutes } = zonedParts(date, timeZone);
  return minutes >= hhmmToMinutes(window.start) && minutes < hhmmToMinutes(window.end);
}

/** UTC ISO bounds [from, to) of the IST calendar day containing `date` (IST has no DST: UTC+05:30). */
export function istDayBounds(date: Date): { from: string; to: string } {
  const { ymd } = zonedParts(date, IST_TIMEZONE);
  const fromMs = Date.parse(`${ymd}T00:00:00+05:30`);
  return { from: new Date(fromMs).toISOString(), to: new Date(fromMs + 24 * 60 * 60 * 1000).toISOString() };
}

/**
 * The instant the calling-hours check is evaluated at: the real time in
 * strict mode, otherwise the IST calendar day of `now` at the simulated hour.
 */
export function effectiveCallingTime(now: Date, opts: CallingHoursOptions = {}): Date {
  if (opts.strictCallingHours === true) return now;
  const hour = opts.simulatedHourIst ?? DEFAULT_SIMULATED_HOUR_IST;
  const { ymd } = zonedParts(now, IST_TIMEZONE);
  return new Date(Date.parse(`${ymd}T${String(hour).padStart(2, '0')}:00:00+05:30`));
}

export function canPlaceCall(
  c: Case,
  directory: readonly Business[],
  clock: Clock,
  opts: CanPlaceCallOptions = {},
): PolicyDecision {
  const parsedOpts = CanPlaceCallOptionsSchema.safeParse(opts);
  if (!parsedOpts.success) {
    return { ok: false, code: 'invalid_options', message: 'policy options failed validation' };
  }
  const options = parsedOpts.data;
  const parsed = CaseSchema.safeParse(c);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_case', message: 'case failed validation' };
  }
  const kase = parsed.data;

  if (kase.status !== 'ready') {
    return { ok: false, code: 'case_not_ready', message: `case status is '${kase.status}', expected 'ready'` };
  }

  const business = directory.find((b) => b.id === kase.businessId);
  if (business === undefined) {
    return { ok: false, code: 'unknown_business', message: `business '${kase.businessId}' is not in the allowlist` };
  }
  if (business.optOut === true) {
    return { ok: false, code: 'business_opted_out', message: `business '${business.id}' has opted out` };
  }

  const now = effectiveCallingTime(clock.now(), options);
  const mode = options.strictCallingHours === true ? 'wall clock' : 'simulated';
  if (!withinWindow(now, CALLING_WINDOW_IST, IST_TIMEZONE)) {
    return {
      ok: false,
      code: 'outside_calling_hours',
      message: `calls allowed ${CALLING_WINDOW_IST.start}-${CALLING_WINDOW_IST.end} IST; effective time ${zonedParts(now, IST_TIMEZONE).hhmm} IST (${mode})`,
    };
  }
  if (!withinWindow(now, business.hours, business.hours.timezone)) {
    return {
      ok: false,
      code: 'outside_calling_hours',
      message: `${business.name} takes calls ${business.hours.start}-${business.hours.end} (${business.hours.timezone})`,
    };
  }

  const placed = options.callsPlacedToday ?? 0;
  if (placed >= business.dailyCap) {
    return {
      ok: false,
      code: 'daily_cap_reached',
      message: `daily cap of ${business.dailyCap} calls to '${business.id}' reached`,
    };
  }

  return { ok: true, business };
}

/** Convenience: canPlaceCall with the daily count read from a CallRepo. */
export async function canPlaceCallWithRepo(
  c: Case,
  directory: readonly Business[],
  clock: Clock,
  calls: Pick<CallRepo, 'countCallsForBusiness'>,
  opts: CallingHoursOptions = {},
): Promise<PolicyDecision> {
  // The daily cap always uses the real IST calendar day.
  const { from, to } = istDayBounds(clock.now());
  const callsPlacedToday = await calls.countCallsForBusiness(c.businessId, from, to);
  return canPlaceCall(c, directory, clock, { ...opts, callsPlacedToday });
}
