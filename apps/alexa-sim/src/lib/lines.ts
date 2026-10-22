/** Merging the phone-line transcript from call_status.lastLines and the transcript resource. */
import type { CallLine, SimTtsVoice } from '@standin/core';
import { maskText } from './redact.js';

export const lineKey = (l: CallLine): string => `${l.at}|${l.speaker}|${l.text}`;

export interface MergeResult {
  lines: CallLine[];
  added: CallLine[];
  /** The incoming window does not overlap what we have: some lines were missed. */
  gap: boolean;
}

/** Append the lines not seen yet (masked), preserving order. */
export function mergeLines(existing: readonly CallLine[], incoming: readonly CallLine[], max = 400): MergeResult {
  const seen = new Set(existing.map(lineKey));
  const masked = incoming.map((l) => ({ ...l, text: maskText(l.text) }));
  const added = masked.filter((l) => !seen.has(lineKey(l)));
  const gap = existing.length > 0 && masked.length > 0 && added.length === masked.length && masked.length >= 3;
  const lines = [...existing, ...added];
  return { lines: lines.length > max ? lines.slice(lines.length - max) : lines, added, gap };
}

/** Which voice speaks a phone-line speaker (the user and system lines are not spoken). */
export function voiceForSpeaker(speaker: CallLine['speaker']): SimTtsVoice | undefined {
  switch (speaker) {
    case 'standin':
      return 'standin';
    case 'ivr':
      return 'ivr';
    case 'agent':
      return 'agent';
    case 'user':
    case 'system':
      return undefined;
  }
}

export const SPEAKER_LABEL: Record<CallLine['speaker'], string> = {
  standin: 'Stand-In',
  ivr: 'Phone menu',
  agent: 'Agent',
  user: 'You',
  system: 'Line',
};
