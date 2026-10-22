import { useState } from 'react';

interface Props {
  error: string | undefined;
  onSubmit(token: string): void;
}

/** Asks once for the Bearer token; it is kept in sessionStorage for this tab only. */
export function TokenGate({ error, onSubmit }: Props) {
  const [token, setToken] = useState('');
  return (
    <div className="overlay gate">
      <form
        className="elicit"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(token);
        }}
      >
        <p className="elicit-msg">Enter the Stand-In access token</p>
        <label className="elicit-field">
          <span>Bearer token</span>
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          <small>Stored in this tab's session storage only. You can also open the page with ?token=…</small>
        </label>
        {error !== undefined && <p className="err">{error}</p>}
        <div className="elicit-actions">
          <button type="submit" className="btn primary" disabled={token.trim().length === 0}>
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
