import { useEffect, useRef } from 'react';
import type { CallLine, CallStatusOutput } from '@standin/core';
import { SPEAKER_LABEL } from '../lib/lines.js';
import { HoldTimer, type HoldScaleSetting } from './HoldTimer.js';

interface Props {
  lines: readonly CallLine[];
  status: CallStatusOutput | undefined;
  polledAt: number;
  businessName: string | undefined;
  holdScale: HoldScaleSetting;
}

const STATE_LABEL: Record<CallStatusOutput['state'], string> = {
  DIALING: 'Dialing',
  IVR: 'Phone menu',
  HOLD: 'On hold',
  HUMAN: 'Agent on the line',
  HANDOFF_PENDING: 'Waiting for you',
  USER_ON_LINE: 'You are on the line',
  WRAP_UP: 'Wrapping up',
  ENDED: 'Call ended',
  FAILED: 'Call failed',
};

/** Right pane: what the business hears and says. */
export function PhoneLine({ lines, status, polledAt, businessName, holdScale }: Props) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [lines.length]);

  const state = status?.state;
  const agentName = status?.outcome?.agentName;
  return (
    <section className="phone" aria-label="The phone line">
      <header className="phone-head">
        <div>
          <h2>The phone line</h2>
          <p className="muted">{businessName ?? 'No call yet'}</p>
        </div>
        <div className={`phone-state ${state === undefined ? '' : `st-${state.toLowerCase()}`}`}>
          {state === undefined ? 'Idle' : STATE_LABEL[state]}
          {state === 'HOLD' && status !== undefined && (
            <span className="phone-hold">
              <HoldTimer holdSeconds={status.holdSeconds} onHold polledAt={polledAt} scale={holdScale} /> on hold
            </span>
          )}
        </div>
      </header>
      {status !== undefined && status.digitsPressed.length > 0 && (
        <div className="phone-dtmf">
          Keys pressed:{' '}
          {status.digitsPressed.map((d, i) => (
            <kbd key={`${d}-${i}`}>{d}</kbd>
          ))}
        </div>
      )}
      <div className="phone-lines">
        {lines.length === 0 && <p className="muted center">When Stand-In calls, you will hear both sides here.</p>}
        {lines.map((l) => (
          <div key={`${l.at}|${l.speaker}|${l.text}`} className={`bubble sp-${l.speaker}`}>
            <span className="who">{l.speaker === 'agent' && agentName !== undefined ? agentName : SPEAKER_LABEL[l.speaker]}</span>
            <span className="what">{l.text}</span>
          </div>
        ))}
        {state === 'HOLD' && <div className="hold-music" aria-hidden="true">♪ hold music ♪</div>}
        <div ref={end} />
      </div>
      <footer className="phone-legend">
        <span className="dot sp-standin" /> Stand-In voice <span className="dot sp-ivr" /> IVR <span className="dot sp-agent" /> Agent
      </footer>
    </section>
  );
}
