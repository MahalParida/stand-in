import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TraceEntry, TraceRecorder } from '../lib/trace.js';

interface Props {
  recorder: TraceRecorder;
  open: boolean;
  onToggle(): void;
}

function arrow(e: TraceEntry): string {
  return e.direction === 'out' ? '→' : '←';
}

function label(e: TraceEntry): string {
  const m = e.method ?? (e.kind === 'error' ? 'error' : 'message');
  return e.tool !== undefined ? `${m} · ${e.tool}` : m;
}

/** Drawer listing every JSON-RPC message with method, id, latency and collapsible JSON. */
export function TracePanel({ recorder, open, onToggle }: Props) {
  const entries = useSyncExternalStore(recorder.subscribe, recorder.entries);
  const [hidePolls, setHidePolls] = useState(false);
  const [follow, setFollow] = useState(true);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (hidePolls ? entries.filter((e) => e.tool !== 'call_status' || e.chips.length > 0) : entries),
    [entries, hidePolls],
  );
  const chips = useMemo(() => entries.flatMap((e) => e.chips.map((c) => ({ ...c, seq: e.seq }))), [entries]);
  const t0 = entries[0]?.at ?? 0;

  useEffect(() => {
    if (follow && open && list.current !== null) list.current.scrollTop = list.current.scrollHeight;
  }, [shown.length, follow, open]);

  return (
    <aside className={`trace ${open ? 'open' : ''}`} aria-label="MCP trace">
      <header className="trace-head">
        <button type="button" className="trace-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? '▾' : '▴'} MCP trace <span className="count">{entries.length}</span>
        </button>
        <div className="trace-chips">
          {chips.slice(-6).map((c) => (
            <span key={`${c.seq}-${c.kind}-${c.label}`} className="chip red" title={c.kind}>
              {c.label}
            </span>
          ))}
        </div>
        {open && (
          <div className="trace-opts">
            <label>
              <input type="checkbox" checked={hidePolls} onChange={(e) => setHidePolls(e.target.checked)} /> hide call_status polls
            </label>
            <label>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
            </label>
            <button type="button" className="link" onClick={() => recorder.clear()}>
              clear
            </button>
          </div>
        )}
      </header>
      {open && (
        <div className="trace-list" ref={list}>
          {shown.map((e) => (
            <details key={e.seq} className={`trace-row k-${e.kind}${e.isError === true ? ' err' : ''}`}>
              <summary>
                <span className="t">+{((e.at - t0) / 1000).toFixed(2)}s</span>
                <span className="dir">{arrow(e)}</span>
                <span className="kind">{e.kind}</span>
                <span className="method">{label(e)}</span>
                {e.id !== undefined && <span className="id">#{String(e.id)}</span>}
                {e.latencyMs !== undefined && <span className="lat">{e.latencyMs} ms</span>}
                {e.httpStatus !== undefined && e.httpStatus >= 400 && <span className="chip red">HTTP {e.httpStatus}</span>}
                {e.chips.map((c) => (
                  <span key={c.kind + c.label} className="chip red">
                    {c.label}
                  </span>
                ))}
              </summary>
              <pre>{JSON.stringify(e.payload, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </aside>
  );
}
