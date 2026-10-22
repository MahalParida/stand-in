/**
 * When call_status keeps failing (the server restarted or redeployed and no
 * longer knows the call), the host must not poll forever with a frozen card:
 * it shows a terminal FAILED state and tells the user.
 */
import type { CallStatusOutput } from '@standin/core';
import type { ToolCallOutcome } from './mcp.js';

/** Consecutive call_status tool errors (other than not_found) before giving up. */
export const MAX_POLL_TOOL_ERRORS = 5;

/** True when this call_status outcome (plus earlier consecutive errors) means the call is lost. */
export function isCallLost(o: ToolCallOutcome, consecutiveErrors: number): boolean {
  if (o.ok) return false;
  return o.errorCode === 'not_found' || consecutiveErrors >= MAX_POLL_TOOL_ERRORS;
}

export const LOST_CALL_SUMMARY = "I lost track of that call because the Stand-In server restarted. No request was confirmed. Want me to try again?";

/** A terminal FAILED status for a call the server no longer knows, keeping what the card already showed. */
export function lostCallStatus(callId: string, caseId: string, prev: CallStatusOutput | undefined): CallStatusOutput {
  return {
    callId,
    caseId,
    state: 'FAILED',
    holdSeconds: prev?.holdSeconds ?? 0,
    lastLines: prev?.lastLines ?? [],
    digitsPressed: prev?.digitsPressed ?? [],
    blockedCount: prev?.blockedCount ?? 0,
    injectionCount: prev?.injectionCount ?? 0,
    failureReason: 'server_restart',
    summary: LOST_CALL_SUMMARY,
  };
}
