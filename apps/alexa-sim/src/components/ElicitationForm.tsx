import { useEffect, useState } from 'react';
import type { ElicitValue } from '../lib/autoplay.js';
import type { ElicitFormProperty } from '../lib/mcp.js';
import type { PendingElicitation } from '../lib/controller.js';

interface Props {
  pending: PendingElicitation;
  onSubmit(id: number, values: Record<string, ElicitValue> | null): void;
}

function initialValue(p: ElicitFormProperty): ElicitValue {
  if (p.type === 'boolean') return typeof p.default === 'boolean' ? p.default : false;
  if (p.type === 'number' || p.type === 'integer') return typeof p.default === 'number' ? p.default : '';
  if (p.enum !== undefined && p.enum.length > 0) return typeof p.default === 'string' ? p.default : (p.enum[0] ?? '');
  if (p.oneOf !== undefined && p.oneOf.length > 0) return p.oneOf[0]?.const ?? '';
  return typeof p.default === 'string' ? p.default : '';
}

const SECRETISH = /otp|pin\b|cvv|password|passcode|code/i;

/** MCP elicitation/create (form mode) rendered on the device screen. */
export function ElicitationForm({ pending, onSubmit }: Props) {
  const { request, autofill, id } = pending;
  const [values, setValues] = useState<Record<string, ElicitValue>>(() =>
    Object.fromEntries(Object.entries(request.properties).map(([k, p]) => [k, initialValue(p)])),
  );

  useEffect(() => {
    if (autofill !== undefined) setValues((v) => ({ ...v, ...autofill }));
  }, [autofill]);

  const submit = (): void => {
    const out: Record<string, ElicitValue> = {};
    for (const [k, p] of Object.entries(request.properties)) {
      const v = values[k];
      if (v === undefined || v === '') continue;
      out[k] = (p.type === 'number' || p.type === 'integer') && typeof v === 'string' ? Number(v) : v;
    }
    onSubmit(id, out);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Stand-In needs a detail">
      <form
        className="elicit"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="elicit-msg">{request.message}</p>
        {Object.entries(request.properties).map(([key, p]) => {
          const label = p.title ?? key;
          const v = values[key];
          const required = request.required.includes(key);
          if (p.type === 'boolean') {
            return (
              <label key={key} className="elicit-check">
                <input type="checkbox" checked={v === true} onChange={(e) => setValues({ ...values, [key]: e.target.checked })} />
                {label}
              </label>
            );
          }
          const options = p.enum ?? p.oneOf?.map((o) => o.const);
          return (
            <label key={key} className="elicit-field">
              <span>
                {label}
                {required ? ' *' : ''}
              </span>
              {options !== undefined ? (
                <select value={String(v ?? '')} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                  {options.map((o, i) => (
                    <option key={o} value={o}>
                      {p.oneOf?.[i]?.title ?? o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  autoFocus
                  type={SECRETISH.test(`${key} ${label}`) ? 'password' : p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}
                  value={typeof v === 'string' || typeof v === 'number' ? v : ''}
                  required={required}
                  autoComplete="off"
                  placeholder={p.description}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              )}
              {p.description !== undefined && <small>{p.description}</small>}
            </label>
          );
        })}
        <div className="elicit-actions">
          <button type="submit" className="btn primary">
            Share
          </button>
          <button type="button" className="btn" onClick={() => onSubmit(id, null)}>
            Not now
          </button>
        </div>
      </form>
    </div>
  );
}
