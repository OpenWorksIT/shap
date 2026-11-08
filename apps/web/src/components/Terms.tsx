/**
 * The terms of use: the points that limit what OpenWorks is responsible for, said plainly and
 * up front, with what the owner told setup said back to them. Shap can't be used until they're
 * accepted (at the end of setup, and again when the published terms change).
 */
import { useState } from 'react';
import { TERMS_URL, TERMS_VERSION, termsPoints } from '@shap/shared';
import { api, ApiError } from '../lib/api';
import { useAuthed } from '../lib/session';
import type { Settings } from '../lib/types';
import { Logo } from './Logo';

export const APP: 'shap' | 'pocket' = 'pocket';

export function TermsReview({ cautions, accepted, onAccepted }: { cautions: string[]; accepted: boolean; onAccepted: (v: boolean) => void }) {
  return (
    <div className="stack terms">
      {cautions.length > 0 && (
        <div className="panel panel-pad stack" style={{ gap: 8 }}>
          <strong className="small">From your answers</strong>
          <ul className="small terms-list">
            {cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="panel panel-pad stack" style={{ gap: 10 }}>
        <strong className="small">The terms of use, in short</strong>
        {termsPoints(APP).map((p) => (
          <div key={p.title}>
            <strong className="small">{p.title}</strong>
            <p className="xs muted" style={{ margin: '2px 0 0' }}>
              {p.body}
            </p>
          </div>
        ))}
        <p className="xs">
          The full terms (version {TERMS_VERSION}) are at{' '}
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            openworks.co.za/shap/terms
          </a>
          . They apply as published there.
        </p>
      </div>
      <label className="check panel panel-pad terms-accept">
        <input type="checkbox" checked={accepted} onChange={(e) => onAccepted(e.target.checked)} />
        <span>
          <strong className="small">I have read and accept the terms of use</strong>
          <div className="xs muted">Including that OpenWorks isn’t an accountant, doesn’t keep or back up my data, and isn’t liable for what I file or pay. I’m responsible for backups, updates and checking the figures.</div>
        </span>
      </label>
    </div>
  );
}

/** The published terms changed (or these books predate them): accept them to carry on. */
export function TermsGate() {
  const { settings, refreshReference } = useAuthed();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agree = async () => {
    setBusy(true);
    setError('');
    try {
      const { logoId: _l, ...rest } = settings as Settings & { logoId: string | null };
      await api('/api/settings', { method: 'PUT', body: { ...rest, lockDate: rest.lockDate ?? null, termsVersion: TERMS_VERSION } });
      await refreshReference();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save');
      setBusy(false);
    }
  };
  return (
    <div className="welcome">
      <div className="welcome-card stack-lg">
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <Logo size={56} />
          <h2>{settings.termsVersion ? 'The terms of use have changed' : 'Before you carry on: the terms of use'}</h2>
          <p className="small muted">Shap now asks everyone to accept its terms of use. Your books are untouched: read them, accept, and carry on where you were.</p>
        </div>
        <TermsReview cautions={[]} accepted={accepted} onAccepted={setAccepted} />
        {error && <div className="banner alert small">{error}</div>}
        <button type="button" className="btn primary big block" disabled={!accepted || busy} onClick={() => void agree()}>
          {busy ? 'Saving…' : 'Accept and open my books'}
        </button>
      </div>
    </div>
  );
}
