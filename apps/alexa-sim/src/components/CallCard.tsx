import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CallStatusOutput } from '@standin/core';
import { CARD_STAGES, STAGE_LABEL, mapCallStatus, stageIndex, type CardView } from '../lib/call-card.js';
import { attachCardBridge, type CallToolResultLike, type CardBridgeHandle } from '../lib/card-bridge.js';
import { SPEAKER_LABEL } from '../lib/lines.js';
import type { McpSession } from '../lib/mcp.js';
import { HoldTimer, type HoldScaleSetting } from './HoldTimer.js';

export interface CardActions {
  join(): void;
  decline(): void;
  leave(): void;
  end(): void;
  answer(text: string, approve: boolean): void;
}

interface Props {
  html: string | undefined;
  session: Pick<McpSession, 'callTool' | 'readResource'> | undefined;
  callId: string | undefined;
  status: CallStatusOutput | undefined;
  polledAt: number;
  caseReady: boolean;
  /** Latest open_case / update_case_fact result, forwarded to the MCP App card. */
  caseResult: CallToolResultLike | undefined;
  businessName: string | undefined;
  holdScale: HoldScaleSetting;
  actions: CardActions;
  onCardToolResult(): void;
}

const INIT_TIMEOUT_MS = 4000;

/**
 * ui://standin/call-card in a sandboxed iframe (MCP Apps bridge), with the
 * native React card as fallback when the resource is missing or the bridge
 * does not initialise.
 */
export function CallCard(props: Props) {
  const [mode, setMode] = useState<'app' | 'native'>(props.html !== undefined ? 'app' : 'native');
  const [why, setWhy] = useState<string | undefined>(props.html === undefined ? 'card resource unavailable' : undefined);

  useEffect(() => {
    if (props.html === undefined) {
      setMode('native');
      setWhy('card resource unavailable');
    }
  }, [props.html]);

  const fallback = useCallback((reason: string): void => {
    setWhy(reason);
    setMode('native');
  }, []);

  return (
    <div className="card-zone">
      {mode === 'app' && props.html !== undefined && props.session !== undefined ? (
        <AppCardFrame {...props} html={props.html} session={props.session} onFail={fallback} />
      ) : (
        <NativeCallCard
          view={mapCallStatus(props.status, {
            caseReady: props.caseReady,
            ...(props.businessName !== undefined ? { businessName: props.businessName } : {}),
          })}
          polledAt={props.polledAt}
          holdScale={props.holdScale}
          actions={props.actions}
        />
      )}
      <div className="card-mode">
        <button
          type="button"
          className="link"
          onClick={() => setMode(mode === 'app' ? 'native' : 'app')}
          disabled={props.html === undefined}
          title={why ?? 'switch card renderer'}
        >
          {mode === 'app' ? 'MCP App card' : `Native card${why !== undefined ? ` · ${why}` : ''}`}
        </button>
      </div>
    </div>
  );
}

function AppCardFrame(props: Props & { html: string; session: Pick<McpSession, 'callTool' | 'readResource'>; onFail(reason: string): void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const handle = useRef<CardBridgeHandle | undefined>(undefined);
  const { html, session, callId, onFail, onCardToolResult } = props;
  const caseResultRef = useRef<CallToolResultLike | undefined>(props.caseResult);
  caseResultRef.current = props.caseResult;

  useLayoutEffect(() => {
    const iframe = ref.current;
    if (iframe === null) return;
    let cancelled = false;
    let initialised = false;
    const timer = window.setTimeout(() => {
      if (!initialised && !cancelled) onFail('card did not initialise');
    }, INIT_TIMEOUT_MS);
    const h = attachCardBridge({
      iframe,
      session,
      callId,
      theme: 'dark',
      onInitialized: () => {
        initialised = true;
      },
      onError: () => {
        if (!cancelled) onFail('card bridge error');
      },
      onToolResult: () => onCardToolResult(),
    });
    handle.current = h;
    if (caseResultRef.current !== undefined) h.pushCaseResult(caseResultRef.current);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      h.close();
      handle.current = undefined;
    };
    // Re-create the bridge when a new call starts.
  }, [html, session, callId, onFail, onCardToolResult]);

  useEffect(() => {
    if (props.caseResult !== undefined) handle.current?.pushCaseResult(props.caseResult);
  }, [props.caseResult]);

  useEffect(() => {
    if (props.status !== undefined) handle.current?.pushStatus(props.status);
  }, [props.status]);

  // key: a new call (or new card HTML) gets a fresh iframe and a fresh bridge.
  return <iframe key={`${callId ?? 'none'}`} ref={ref} className="card-frame" title="Stand-In call card" sandbox="allow-scripts" srcDoc={html} />;
}

interface NativeProps {
  view: CardView;
  polledAt: number;
  holdScale: HoldScaleSetting;
  actions: CardActions;
}

export function NativeCallCard({ view, polledAt, holdScale, actions }: NativeProps) {
  const [answer, setAnswer] = useState('');
  const idx = stageIndex(view.stage);
  return (
    <div className={`ncard stage-${view.stage}${view.failed ? ' failed' : ''}`} data-stage={view.stage}>
      <ol className="ncard-steps" aria-label="call progress">
        {CARD_STAGES.map((s, i) => (
          <li key={s} className={i < idx ? 'past' : i === idx ? 'now' : ''}>
            {STAGE_LABEL[s]}
          </li>
        ))}
      </ol>
      <div className="ncard-head">
        <span className="ncard-badge">{view.failed ? 'Failed' : STAGE_LABEL[view.stage]}</span>
        <h3>{view.headline}</h3>
      </div>
      {view.stage === 'menu' && view.digits.length > 0 && (
        <div className="ncard-digits">
          {view.digits.map((d, i) => (
            <kbd key={`${d}-${i}`}>{d}</kbd>
          ))}
        </div>
      )}
      {view.stage === 'hold' && (
        <div className="ncard-hold">
          <HoldTimer holdSeconds={view.holdSeconds} onHold polledAt={polledAt} scale={holdScale} className="hold-big" />
          <span>on hold</span>
        </div>
      )}
      {view.detail !== undefined && view.stage !== 'hold' && <p className="ncard-detail">{view.detail}</p>}
      {(view.stage === 'talking' || view.stage === 'needs_you') && view.lines.length > 0 && (
        <ul className="ncard-lines">
          {view.lines.map((l) => (
            <li key={`${l.at}-${l.speaker}-${l.text}`} className={`sp-${l.speaker}`}>
              <b>{SPEAKER_LABEL[l.speaker]}:</b> {l.text}
            </li>
          ))}
        </ul>
      )}
      {view.stage === 'done' && !view.failed && (
        <dl className="ncard-outcome">
          {view.ticketId !== undefined && (
            <>
              <dt>Ticket</dt>
              <dd className="mono">{view.ticketId}</dd>
            </>
          )}
          {view.outcomeWhat !== undefined && (
            <>
              <dt>Promised</dt>
              <dd>{view.outcomeWhat}</dd>
            </>
          )}
          {view.dueBy !== undefined && (
            <>
              <dt>By</dt>
              <dd>{view.dueBy}</dd>
            </>
          )}
          <dt>Follow-up</dt>
          <dd>{view.followupScheduled ? 'Scheduled ✓' : 'Not scheduled'}</dd>
        </dl>
      )}
      {(view.blockedCount > 0 || view.injectionCount > 0) && (
        <div className="ncard-guard">
          {view.blockedCount > 0 && <span className="chip red">blocked ×{view.blockedCount}</span>}
          {view.injectionCount > 0 && <span className="chip red">injection ×{view.injectionCount}</span>}
        </div>
      )}
      {view.actions.length > 0 && (
        <div className="ncard-actions">
          {view.actions.includes('join') && (
            <button type="button" className="btn primary" onClick={actions.join}>
              Join call
            </button>
          )}
          {view.actions.includes('answer') && (
            <form
              className="ncard-answer"
              onSubmit={(e) => {
                e.preventDefault();
                actions.answer(answer, view.pendingQuestion?.kind === 'confirm');
                setAnswer('');
              }}
            >
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={view.pendingQuestion?.label ?? 'Your answer'}
                aria-label="answer for the business"
              />
              <button type="submit" className="btn primary">
                {view.pendingQuestion?.kind === 'confirm' ? 'Approve & share' : 'Answer'}
              </button>
            </form>
          )}
          {view.actions.includes('decline') && (
            <button type="button" className="btn" onClick={actions.decline}>
              Decline
            </button>
          )}
          {view.actions.includes('leave') && (
            <button type="button" className="btn" onClick={actions.leave}>
              Leave call
            </button>
          )}
          {view.actions.includes('end') && (
            <button type="button" className="btn ghost" onClick={actions.end}>
              End call
            </button>
          )}
        </div>
      )}
    </div>
  );
}
