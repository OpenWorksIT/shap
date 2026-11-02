/**
 * Wipe all data (POPIA's right to erasure, or starting over): the books go, the people who sign
 * in stay. Two steps so nobody does it by accident: a last chance to back up, then the business's
 * name typed out and the owner's password.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Drawer, Icon } from './ui';

export function WipeData() {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel panel-pad stack narrow-wide">
      <h3>Wipe all data</h3>
      <p className="small">
        Deletes the books on this server: invoices, quotes, clients, costs and slip photos, workers, payroll and settings. Shap starts again from the first-run
        questions. The people who sign in and the audit log stay. Backups already made aren’t touched (delete those yourself if they must go too).
      </p>
      <button className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        <Icon name="trash" size={18} />
        Wipe all data…
      </button>
      {open && <WipeSteps onClose={() => setOpen(false)} />}
    </section>
  );
}

function WipeSteps({ onClose }: { onClose: () => void }) {
  const { data } = useApi<{ names: string[] }>('/api/wipe');
  const word = data?.names[0] ?? '';
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = Boolean(data?.names.some((n) => n.toLowerCase() === typed.trim().toLowerCase()));

  const wipe = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/wipe', { body: { name: typed, password } });
      window.location.replace('/');
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : 'Couldn’t wipe the books. Nothing was deleted.');
    }
  };

  return (
    <Drawer title="Wipe all data" onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <ol className="steps-dots small">
          <li className={step === 1 ? 'on' : 'done'}>Back up</li>
          <li className={step === 2 ? 'on' : ''}>Confirm</li>
        </ol>
        {step === 1 ? (
          <>
            <div className="banner signal small">
              <strong>This can’t be undone.</strong> Once it’s wiped, the only way back is a backup.
            </div>
            <p className="small">
              Want a copy first (for your accountant, SARS’s five years, or in case you change your mind)? Download the latest backup under Backups on this page, and
              the company file under <Link to="/settings?tab=import">Import &amp; company file</Link>. Accounts → Export has the books as spreadsheets.
            </p>
            <button className="btn primary block" onClick={() => setStep(2)}>
              I have what I need: next
            </button>
          </>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (matches && password) void wipe();
            }}
          >
            <label className="field">
              <span className="label">
                Type <strong>{word}</strong> to confirm
              </span>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
            </label>
            <label className="field">
              <span className="label">Your password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <div className="banner alert small">{error}</div>}
            <button className="btn danger big block" disabled={!matches || !password || busy}>
              {busy ? 'Wiping…' : 'Wipe everything'}
            </button>
            <button type="button" className="btn quiet block" disabled={busy} onClick={onClose}>
              Keep my books
            </button>
          </form>
        )}
      </div>
    </Drawer>
  );
}
