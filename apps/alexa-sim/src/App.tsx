import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SimController } from './lib/controller.js';
import { DeviceScreen } from './components/DeviceScreen.js';
import { PhoneLine } from './components/PhoneLine.js';
import { TokenGate } from './components/TokenGate.js';
import { TracePanel } from './components/TracePanel.js';
import type { HoldScaleSetting } from './components/HoldTimer.js';

const STAGE_W = 1280;
const STAGE_H = 800;

function holdScaleFromUrl(): HoldScaleSetting {
  const raw = new URLSearchParams(window.location.search).get('holdScale');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 'auto';
}

/** Fit the fixed 1280x800 stage into the window. */
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const fit = (): void => setScale(Math.min(1, window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

export function App({ ctl }: { ctl: SimController }) {
  const state = useSyncExternalStore(ctl.subscribe, ctl.getState);
  const [traceOpen, setTraceOpen] = useState(true);
  const holdScale = useRef(holdScaleFromUrl()).current;
  const scale = useStageScale();

  useEffect(() => {
    void ctl.init();
  }, [ctl]);

  const businessName = state.caseView?.businessName;

  return (
    <div className="viewport">
      <div className="stage" style={{ transform: `scale(${scale})` }}>
        <header className="topbar">
          <div className="title">
            <strong>Stand-In</strong> <span className="muted">· simulated voice-assistant host (real MCP client)</span>
          </div>
          <div className="top-actions">
            {state.autoplay !== undefined && <span className="chip">autoplay: {state.autoplay}</span>}
            {state.config !== undefined && (
              <span className="chip" title="LLM / TTS backends">
                {state.config.llm} · {state.config.tts}
              </span>
            )}
            <span className={`chip conn conn-${state.phase}`}>{state.phase}</span>
            <button type="button" className="btn small" onClick={() => ctl.setMuted(!state.muted)}>
              {state.muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="btn small" onClick={() => void ctl.resetTake()}>
              Reset take
            </button>
          </div>
        </header>

        <main className={`split ${traceOpen ? 'trace-open' : ''}`}>
          <DeviceScreen ctl={ctl} state={state} holdScale={holdScale} />
          <PhoneLine
            lines={state.phoneLines}
            status={state.call?.status}
            polledAt={state.call?.polledAt ?? 0}
            businessName={businessName}
            holdScale={holdScale}
          />
        </main>

        <TracePanel recorder={ctl.recorder} open={traceOpen} onToggle={() => setTraceOpen(!traceOpen)} />

        {state.phase === 'need_token' && <TokenGate error={state.error} onSubmit={(t) => void ctl.submitToken(t)} />}
        {state.phase === 'error' && (
          <div className="overlay gate">
            <div className="elicit">
              <p className="elicit-msg">Can't start the host</p>
              <p className="err">{state.error}</p>
              <button type="button" className="btn primary" onClick={() => window.location.reload()}>
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
