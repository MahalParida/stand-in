/**
 * Honest, specific user-facing copy for every way a call can fail or be
 * refused (spec S5: "user told honestly"). Shared by the call agent (stored
 * failure message), the MCP server (call_status summary, place_call refusals),
 * the MCP Apps card and the sim host's native card. Browser-safe.
 *
 * Every message says what happened, whether anything was dialled or shared,
 * and what the user can do next. None of them carries case data.
 */
import { CALLING_WINDOW_IST } from './policy.js';
import { FailureReasonSchema, type FailureReason } from './types.js';

export interface FailureCopy {
  /** Short card headline. */
  headline: string;
  /** One or two speakable sentences for the card detail and the assistant's reply. */
  message: string;
}

export interface FailureCopyContext {
  businessName?: string | undefined;
  /** ivr_dead_end: how many times the menu looped. */
  ivrLoops?: number | undefined;
  /** max_duration: the limit in minutes. */
  maxMinutes?: number | undefined;
}

export function failureCopy(reason: FailureReason, ctx: FailureCopyContext = {}): FailureCopy {
  const b = ctx.businessName !== undefined && ctx.businessName.trim().length > 0 ? ctx.businessName.trim() : 'the business';
  switch (reason) {
    case 'ivr_dead_end':
      return {
        headline: 'Stuck in the phone menu',
        message: `I couldn't reach a person at ${b}: their phone menu kept sending me back to the start${ctx.ivrLoops !== undefined ? ` (${ctx.ivrLoops} loops)` : ''}, so I hung up. Nothing was shared and no request was raised.`,
      };
    case 'max_duration':
      return {
        headline: 'Call ran too long',
        message: `The call to ${b} ran past the ${ctx.maxMinutes !== undefined ? `${ctx.maxMinutes}-minute ` : ''}limit, so I hung up without a resolution. No request was confirmed.`,
      };
    case 'remote_hangup':
      return { headline: 'They hung up', message: `${b} hung up before giving a resolution. No request was confirmed. I can call again if you like.` };
    case 'dial_failed':
      return { headline: "Couldn't connect", message: `I couldn't connect to ${b}; the call never got through. Nothing was shared. I can try again later.` };
    case 'carrier_error':
      return {
        headline: 'Phone line failed',
        message: `The phone line to ${b} failed, so the call was stopped. No request was confirmed. You can ask me to try again.`,
      };
    case 'error':
      return { headline: 'Something went wrong', message: `Something went wrong on the line with ${b}, so the call was stopped. No request was confirmed.` };
    case 'server_restart':
      return {
        headline: 'Call dropped: Stand-In restarted',
        message: `The call to ${b} was dropped because Stand-In restarted. No request was confirmed. Ask me to try again.`,
      };
    case 'outside_calling_hours':
      return {
        headline: 'Outside calling hours',
        message: `I didn't call ${b}: I only place calls between ${CALLING_WINDOW_IST.start} and ${CALLING_WINDOW_IST.end} IST, and it's outside that window. Nothing was dialled. Ask me again during calling hours.`,
      };
    case 'not_allowlisted':
      return {
        headline: 'Not in the Stand-In directory',
        message: `I can't call ${b}: I only dial businesses from Stand-In's vetted directory, and this one isn't on it. Nothing was dialled.`,
      };
    case 'daily_cap_reached':
      return {
        headline: 'Daily call limit reached',
        message: `I've already called ${b} as many times as allowed today, so I didn't call again. Nothing was dialled. I can try tomorrow.`,
      };
    case 'call_setup_failed':
      return {
        headline: "Couldn't start the call",
        message: `I couldn't set up the call to ${b} because of a problem on my side. Nothing was dialled and your case is unchanged. Please try again in a moment.`,
      };
  }
}

/**
 * The FailureReason a place_call refusal code maps to (unknown business and
 * an opted-out business both read as "not in the directory"), or undefined for
 * codes that are not a failure the user needs explained (e.g. case_not_ready).
 */
export function refusalReason(code: string): FailureReason | undefined {
  switch (code) {
    case 'unknown_business':
    case 'business_opted_out':
    case 'not_allowlisted':
      return 'not_allowlisted';
    case 'outside_calling_hours':
    case 'daily_cap_reached':
    case 'call_setup_failed':
      return code;
    default: {
      const r = FailureReasonSchema.safeParse(code);
      return r.success ? r.data : undefined;
    }
  }
}
