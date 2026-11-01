/** Backup and restore, and the phone lock. */
import { useEffect, useState } from 'react';
import { formatDate } from '@shap/shared';
import { lockEnabled, phoneHasLock, setLock } from '../components/AppLock';
import { PageHead } from '../components/Shell';
import { Icon, useToast } from '../components/ui';
import { backUp, lastBackup, restoreFrom } from '../lib/backup';
import { isNative, pickFile, platform } from '../lib/native';
import { useAuthed } from '../lib/session';

export default function BackupPage() {
  const { settings } = useAuthed();
  const toast = useToast();
  const [busy, setBusy] = useState<'' | 'backup' | 'restore'>('');
  const [last, setLast] = useState(lastBackup());
  const [lock, setLockState] = useState<boolean | null>(null);
  const [canLock, setCanLock] = useState(false);
  const name = settings.tradingName || settings.companyName;

  useEffect(() => {
    void lockEnabled().then(setLockState);
    void phoneHasLock().then(setCanLock);
  }, []);

  const doBackup = async () => {
    setBusy('backup');
    try {
      const r = await backUp(name);
      if (r !== 'cancelled') {
        setLast(lastBackup());
        toast(r === 'downloaded' ? 'Backup saved' : 'Backup handed over');
      }
    } catch (err) {
      toast((err as Error).message || 'Couldn’t make the backup', 'error');
    } finally {
      setBusy('');
    }
  };

  const doRestore = async () => {
    const file = await pickFile([]);
    if (!file) return;
    if (!confirm(`Replace everything on this phone with the backup “${file.name}”? What’s here now is lost unless it’s in another backup.`)) return;
    setBusy('restore');
    try {
      await restoreFrom(file);
      toast('Backup restored');
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      toast(`That file couldn’t be restored: ${(err as Error).message}`, 'error');
      setBusy('');
    }
  };

  const where =
    platform() === 'ios'
      ? 'Tap Save to Files, then choose iCloud Drive, OneDrive, Google Drive or Proton Drive (whichever apps you have).'
      : platform() === 'android'
        ? 'Choose Drive, OneDrive or Proton Drive (whichever apps you have), or Save to device.'
        : 'The backup downloads; keep it somewhere safe, like your cloud drive.';
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86_400_000) : null;

  return (
    <div className="stack-lg narrow-wide">
      <PageHead title="Backup" sub="Your books live only on this phone. Keep a copy somewhere else." />
      <section className="panel panel-pad stack">
        <h3>Back up</h3>
        <p className="small">
          One file with everything: invoices, costs, slips, settings. {where}
        </p>
        <p className={`small ${days == null || days > 7 ? 'warn-text' : 'muted'}`}>
          {last ? `Last backup: ${formatDate(last.toISOString().slice(0, 10))}${days ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ' (today)'}.` : 'No backup yet from this phone.'}
        </p>
        <button className="btn primary big block" onClick={() => void doBackup()} disabled={Boolean(busy)}>
          <Icon name="upload" size={18} />
          {busy === 'backup' ? 'Making the backup…' : 'Back up now'}
        </button>
        <p className="xs muted">Shap also keeps a safety copy inside the app, so a phone update or low storage doesn’t lose your books. That copy goes if the app is deleted or the phone is lost: back up as well, at least once a week.</p>
      </section>

      <section className="panel panel-pad stack">
        <h3>Restore</h3>
        <p className="small">New phone, or need to go back? Choose a backup file (from Files, Drive, OneDrive…). It replaces everything on this phone.</p>
        <button className="btn block" onClick={() => void doRestore()} disabled={Boolean(busy)}>
          {busy === 'restore' ? 'Restoring…' : 'Restore a backup…'}
        </button>
      </section>

      {isNative() && (
        <section className="panel panel-pad stack">
          <h3>Lock</h3>
          {canLock ? (
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(lock)}
                disabled={lock === null}
                onChange={async (e) => {
                  const want = e.target.checked;
                  if (await setLock(want)) setLockState(want);
                  else toast('Not switched on: the phone didn’t confirm it was you', 'error');
                }}
              />
              <span>
                Ask for Face ID, fingerprint or your phone’s PIN when Shap opens
                <div className="xs muted">The same lock as your phone. Asked again when you come back after a minute away.</div>
              </span>
            </label>
          ) : (
            <p className="small muted">Set a screen lock (PIN, fingerprint or face) in your phone’s settings to lock Shap too.</p>
          )}
        </section>
      )}
    </div>
  );
}
