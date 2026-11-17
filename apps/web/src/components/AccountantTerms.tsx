/**
 * The Shap Accountant terms of use (terms.ts): Shap's terms, with what a practice takes on when it
 * keeps its clients' books in Shap, said plainly before its owner accepts them for the practice.
 * Asked before Shap Accountant is switched on (Settings → What you use) and again whenever the
 * terms change (Practice). Shap's own terms, for everyone else, don't change with them.
 */
import { useState } from 'react';
import { ACCOUNTANT_TERMS_TICK, ACCOUNTANT_TERMS_URL, ACCOUNTANT_TERMS_VERSION, accountantTermsPoints, TERMS_URL } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';

/** The points, for a practice; shown in a client's books too, where the practice accepts them for those books. */
export function AccountantPoints() {
  return (
    <div className="panel panel-pad stack" style={{ gap: 10 }}>
      <strong className="small">The Shap Accountant terms, in short</strong>
      {accountantTermsPoints().map((p) => (
        <div key={p.title}>
          <strong className="small">{p.title}</strong>
          <p className="xs muted" style={{ margin: '2px 0 0' }}>
            {p.body}
          </p>
        </div>
      ))}
      <p className="xs">
        The full Shap Accountant terms (version {ACCOUNTANT_TERMS_VERSION}) are at{' '}
        <a href={ACCOUNTANT_TERMS_URL} target="_blank" rel="noreferrer">
          openworks.co.za/shap/accountant-terms
        </a>
        , with Shap’s own terms (
        <a href={TERMS_URL} target="_blank" rel="noreferrer">
          openworks.co.za/shap/terms
        </a>
        ) in them. They apply as published there.
      </p>
    </div>
  );
}

/** The owner accepts them for the practice; `cautions`: what switching it on means, said back. */
export function AccountantTermsAccept({ cautions = [], onAccepted }: { cautions?: string[]; onAccepted: () => void | Promise<void> }) {
  const { refreshReference } = useAuthed();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/practice/terms', { body: { version: ACCOUNTANT_TERMS_VERSION } });
      await refreshReference();
      await onAccepted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack terms">
      {cautions.length > 0 && (
        <div className="panel panel-pad stack" style={{ gap: 8 }}>
          <strong className="small">What your practice answers for</strong>
          <ul className="small terms-list">
            {cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <AccountantPoints />
      <label className="check panel panel-pad terms-accept">
        <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        <span>
          <strong className="small">{ACCOUNTANT_TERMS_TICK}</strong>
          <div className="xs muted">Including that my practice’s work for its clients is its own, that Shap’s checks and returns are aids, that my practice looks after its clients’ books and personal information, and that it indemnifies OpenWorks against claims over that work.</div>
        </span>
      </label>
      {error && <div className="banner alert small">{error}</div>}
      <button type="button" className="btn primary block" disabled={!ticked || busy} onClick={() => void accept()}>
        {busy ? 'Saving…' : 'Accept for my practice'}
      </button>
    </div>
  );
}
