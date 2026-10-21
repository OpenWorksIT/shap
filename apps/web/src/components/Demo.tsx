import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

interface Status {
  available: boolean;
  active: boolean;
}

let cached: Promise<Status> | null = null;
/** Is this browser showing the demo company (and is there one)? */
export function useDemoStatus(): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    cached ??= api<Status>('/api/demo/status').catch(() => ({ available: false, active: false }));
    void cached.then(setS);
  }, []);
  return s;
}

/** Settings: swap this phone over to the made-up company, to show Shap to someone. */
export function ShowDemoButton() {
  const s = useDemoStatus();
  const [busy, setBusy] = useState(false);
  if (!s?.available || s.active) return null;
  return (
    <button
      className="btn"
      disabled={busy}
      title="Show Shap with a made-up company instead of your own figures"
      onClick={async () => {
        setBusy(true);
        try {
          await api('/api/demo/enter', { body: {} });
          window.location.assign('/');
        } catch (err) {
          alert(err instanceof ApiError ? err.message : 'Couldn’t open the demo company');
          setBusy(false);
        }
      }}
    >
      {busy ? 'Opening the demo…' : 'Show the demo company'}
    </button>
  );
}

/**
 * Across the top while the demo company is showing, so it's never mistaken for the real books.
 * Getting back asks for your password, in case the phone was handed over.
 */
export function DemoBanner() {
  const s = useDemoStatus();
  const [leaving, setLeaving] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!s?.active) return null;
  const leave = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/demo/leave', { body: { password } });
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t go back');
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!confirm('Put the demo company back as new? Anything added while showing it goes.')) return;
    setBusy(true);
    try {
      await api('/api/demo/reset', { body: {} });
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t reset it');
      setBusy(false);
    }
  };
  return (
    <div className="demo-banner" role="status">
      <span className="grow">
        <strong>Demo company.</strong> Made-up figures: nothing here is real.
      </span>
      {leaving ? (
        <form className="row" style={{ gap: 6 }} onSubmit={leave}>
          <input
            className="input small-input"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            aria-label="Your password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn small primary" disabled={busy}>
            {busy ? '…' : 'Back'}
          </button>
          <button type="button" className="btn small quiet" onClick={() => (setLeaving(false), setError(''))}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button className="btn small quiet" disabled={busy} onClick={() => void reset()}>
            Reset demo
          </button>
          <button className="btn small" onClick={() => setLeaving(true)}>
            Back to my books
          </button>
        </>
      )}
      {error && <span className="xs warn-text">{error}</span>}
    </div>
  );
}
