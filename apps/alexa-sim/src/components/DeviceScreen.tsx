import { useCallback, useMemo, useRef, useState } from 'react';
import type { SimController, SimState } from '../lib/controller.js';
import { mapCallStatus, takeoverButton } from '../lib/call-card.js';
import { listenOnce, speechInputSupported, type ListenHandle } from '../lib/speech-input.js';
import { CallCard, type CardActions } from './CallCard.js';
import { ElicitationForm } from './ElicitationForm.js';
import type { HoldScaleSetting } from './HoldTimer.js';

interface Props {
  ctl: SimController;
  state: SimState;
  holdScale: HoldScaleSetting;
}

function clock(): string {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Left pane: the Home Hub screen (Echo-Show-style, generic). */
export function DeviceScreen({ ctl, state, holdScale }: Props) {
  const [mic, setMic] = useState<ListenHandle | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const status = state.call?.status;
  const view = useMemo(
    () =>
      mapCallStatus(status, {
        caseReady: state.caseReady,
        ...(state.caseView?.businessName !== undefined ? { businessName: state.caseView.businessName } : {}),
      }),
    [status, state.caseReady, state.caseView?.businessName],
  );
  const lastUser = [...state.chat].reverse().find((c) => c.role === 'user');
  const lastReply = [...state.chat].reverse().find((c) => c.role === 'assistant');
  const ringing = view.stage === 'needs_you' && view.actions.includes('join');
  const callActive = state.call !== undefined && view.active;
  const takeover = takeoverButton(status?.state);

  const actions: CardActions = useMemo(
    () => ({
      join: () => void ctl.handoff(true),
      decline: () => void ctl.handoff(false),
      leave: () => void ctl.leave(),
      end: () => void ctl.endCall(),
      answer: (text, approve) => void ctl.answer(text, approve),
    }),
    [ctl],
  );
  const onCardToolResult = useCallback(() => void ctl.pollNow(), [ctl]);

  const toggleMic = (): void => {
    if (mic !== undefined) {
      mic.stop();
      return;
    }
    const h = listenOnce({
      onInterim: (t) => ctl.setDraft(t),
      onFinal: (t) => void ctl.submit(t),
      onEnd: () => {
        setMic(undefined);
        ctl.setListening(false);
      },
      onError: () => {
        setMic(undefined);
        ctl.setListening(false);
        inputRef.current?.focus();
      },
    });
    if (h !== undefined) {
      setMic(h);
      ctl.setListening(true);
    }
  };

  const showCard = state.caseView !== undefined || state.call !== undefined;

  return (
    <section className="device" aria-label="Home Hub">
      <div className="bezel">
        <div className="screen">
          <div className="statusbar">
            <span>{clock()}</span>
            <span className="brand">Home Hub · Stand-In add-on</span>
            <span className={`mode mode-${state.config?.mode ?? 'offline'}`}>{state.config?.mode ?? '…'}</span>
          </div>

          {state.banner !== undefined && <div className="banner">{state.banner}</div>}

          <div className="convo">
            {lastUser !== undefined && <p className="you">“{lastUser.text}”</p>}
            <p className={`reply ${state.busy ? 'thinking' : ''}`}>
              {state.busy ? 'Working on it…' : (lastReply?.text ?? 'Try: “My BharatNet broadband has been down three days. Sort it out.”')}
            </p>
          </div>

          {showCard && (
            <CallCard
              html={state.cardHtml}
              session={state.phase === 'ready' ? ctl.cardSession : undefined}
              callId={state.call?.callId}
              status={status}
              polledAt={state.call?.polledAt ?? 0}
              caseReady={state.caseReady}
              caseResult={state.caseResult}
              businessName={state.caseView?.businessName}
              holdScale={holdScale}
              actions={actions}
              onCardToolResult={onCardToolResult}
            />
          )}

          {state.notice !== undefined && <div className="toast">{state.notice}</div>}

          <form
            className="inputbar"
            onSubmit={(e) => {
              e.preventDefault();
              void ctl.submit(state.draft);
            }}
          >
            <button
              type="button"
              className={`mic ${state.listening ? 'on' : ''}`}
              onClick={toggleMic}
              disabled={!speechInputSupported() || state.busy}
              aria-label={state.listening ? 'Stop listening' : 'Speak'}
              title={speechInputSupported() ? 'Speak' : 'Speech input not supported in this browser: type instead'}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
              </svg>
            </button>
            <input
              ref={inputRef}
              value={state.draft}
              onChange={(e) => ctl.setDraft(e.target.value)}
              placeholder={state.listening ? 'Listening…' : 'Say or type a request'}
              aria-label="Request"
              disabled={state.phase !== 'ready'}
            />
            <button type="submit" className="btn primary" disabled={state.busy || state.draft.trim().length === 0}>
              Send
            </button>
            {callActive && (
              <button
                type="button"
                className="btn takeover"
                disabled={takeover.action === undefined}
                title={takeover.title}
                onClick={() => {
                  if (takeover.action === 'leave') void ctl.leave();
                  else if (takeover.action === 'join') void ctl.handoff(true);
                }}
              >
                {takeover.label}
              </button>
            )}
          </form>

          {ringing && (
            <div className="overlay ring" role="alertdialog" aria-label="Incoming hand-off">
              <div className="ring-card">
                <div className="ring-pulse" aria-hidden="true" />
                <h3>{view.headline}. Join?</h3>
                {view.pendingQuestion !== undefined && <p>{view.pendingQuestion.askedText}</p>}
                <div className="elicit-actions">
                  <button type="button" className="btn primary" onClick={actions.join}>
                    Join call
                  </button>
                  <button type="button" className="btn" onClick={actions.decline}>
                    Decline
                  </button>
                </div>
              </div>
            </div>
          )}

          {state.elicitation !== undefined && (
            <ElicitationForm key={state.elicitation.id} pending={state.elicitation} onSubmit={(id, v) => ctl.answerElicitation(id, v)} />
          )}
        </div>
      </div>
    </section>
  );
}
