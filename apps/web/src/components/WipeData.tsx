/**
 * Wipe everything (POPIA's right to erasure, or just starting over): every invoice, client, slip,
 * worker and setting on this phone goes. Three steps so nobody does it by accident: a last chance
 * to back up, typing the business's name, and the phone's own lock.
 */
import { useState } from 'react';
import { erase } from '../pocket/engine';
import { backUp, scheduleBackupReminder } from '../lib/backup';
import { isNative } from '../lib/native';
import { useAuthed } from '../lib/session';
import { phoneHasLock, unlock } from './AppLock';
import { Drawer, Icon, useToast } from './ui';

export function WipeData() {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel panel-pad stack narrow-wide">
      <h3>Wipe all data</h3>
      <p className="small">
        Deletes everything Shap Pocket keeps on this phone: invoices, quotes, clients, costs and slip photos, workers, payroll and settings. Backups you’ve saved
        elsewhere aren’t touched (delete those yourself if you want them gone too).
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
  const { settings, ref } = useAuthed();
  const toast = useToast();
  const name = (ref.brands.find((b) => b.id === settings.defaultBrandId)?.name || ref.brands[0]?.name || settings.companyName || '').trim();
  const word = name || 'WIPE';
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim().toLowerCase() === word.toLowerCase();

  const backup = async () => {
    try {
      const r = await backUp(name);
      if (r !== 'cancelled') toast('Backup saved');
    } catch {
      toast('Couldn’t make the backup', 'error');
    }
  };

  const wipe = async () => {
    setError('');
    if (isNative() && (await phoneHasLock()) && !(await unlock('Confirm it’s you to wipe all data'))) {
      setError('The phone’s lock wasn’t given, so nothing was wiped.');
      return;
    }
    setBusy(true);
    try {
      await erase();
      await scheduleBackupReminder(false);
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* fine */
      }
      if (isNative()) {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.clear();
      }
      window.location.replace('/');
    } catch {
      setBusy(false);
      setError('Something went wrong while wiping. Close the app and open it again: if your books are still there, nothing was deleted.');
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
              <strong>This can’t be undone.</strong> Once it’s wiped, the only way back is a backup file.
            </div>
            <p className="small">Want a copy first (for your accountant, SARS’s five years, or in case you change your mind)? Save a backup now.</p>
            <button className="btn block" onClick={() => void backup()}>
              <Icon name="download" size={18} />
              Back up first
            </button>
            <button className="btn primary block" onClick={() => setStep(2)}>
              Next
            </button>
          </>
        ) : (
          <>
            <p className="small">
              Type <strong>{word}</strong> to confirm.{isNative() ? ' Then the phone asks for its lock.' : ''}
            </p>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${word} to confirm`} autoFocus autoComplete="off" />
            {error && <div className="banner alert small">{error}</div>}
            <button className="btn danger big block" disabled={!matches || busy} onClick={() => void wipe()}>
              {busy ? 'Wiping…' : 'Wipe everything'}
            </button>
            <button className="btn quiet block" disabled={busy} onClick={onClose}>
              Keep my books
            </button>
          </>
        )}
      </div>
    </Drawer>
  );
}
