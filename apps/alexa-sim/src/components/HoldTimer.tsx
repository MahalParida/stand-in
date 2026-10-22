import { useEffect, useRef, useState } from 'react';
import { autoHoldScale, formatHold, racingHoldSeconds } from '../lib/call-card.js';

export type HoldScaleSetting = number | 'auto';

interface Props {
  holdSeconds: number;
  onHold: boolean;
  /** performance.now() of the status that carried holdSeconds. */
  polledAt: number;
  scale: HoldScaleSetting;
  className?: string;
}

/** Racing "38:12 on hold" counter driven by call_status.holdSeconds. */
export function HoldTimer({ holdSeconds, onHold, polledAt, scale, className }: Props) {
  const [, tick] = useState(0);
  const first = useRef<{ holdSeconds: number; atMs: number } | undefined>(undefined);
  const resolved = useRef<number | undefined>(typeof scale === 'number' ? scale : undefined);
  const shown = useRef(0);

  useEffect(() => {
    if (!onHold) return;
    const id = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [onHold]);

  if (onHold && first.current === undefined) first.current = { holdSeconds, atMs: polledAt };
  if (resolved.current === undefined && scale === 'auto' && first.current !== undefined) {
    resolved.current = autoHoldScale(first.current, { holdSeconds, atMs: polledAt });
  }
  const k = resolved.current ?? (scale === 'auto' ? 1 : scale);
  const value = racingHoldSeconds(holdSeconds, performance.now() - polledAt, k, onHold);
  // Never run backwards (scale decisions and poll jitter).
  shown.current = Math.max(shown.current, value);

  return <span className={className}>{formatHold(shown.current)}</span>;
}
