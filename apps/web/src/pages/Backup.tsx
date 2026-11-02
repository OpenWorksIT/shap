/** Backup and restore, and the phone lock. */
import { useEffect, useState } from 'react';
import { formatDate } from '@shap/shared';
import { lockEnabled, phoneHasLock, setLock } from '../components/AppLock';
import { PageHead } from '../components/Shell';
import { Icon, useToast } from '../components/ui';
import { BACKUP_PLACES, backUp, backupPlace, lastBackup, placeSteps, remindOn, restoreFrom, scheduleBackupReminder, setBackupPlace, type BackupPlace } from '../lib/backup';
import { isNative, pickFile, platform } from '../lib/native';
import { useAuthed } from '../lib/session';

export default function BackupPage() {
  const { settings } = useAuthed();
  const toast = useToast();
  const [busy, setBusy] = useState<'' | 'backup' | 'restore'>('');
  const [last, setLast] = useState(lastBackup());
  const [lock, setLockState] = useState<boolean | null>(null);
  const [canLock, setCanLock] = useState(false);
  const [place, setPlace] = useState<BackupPlace | null>(backupPlace());
  const [remind, setRemind] = useState(remindOn());
  const os = platform();
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
        <p className="small">One file with everything: invoices, costs, slips, settings.{place ? '' : ` ${where}`}</p>
        <label className="small row wrap" style={{ gap: 8 }}>
          <span>Where you keep them:</span>
          <select
            className="select"
            style={{ maxWidth: 220 }}
            value={place ?? ''}
            onChange={(e) => {
              const p = (e.target.value || null) as BackupPlace | null;
              setPlace(p);
              setBackupPlace(p);
            }}
          >
            <option value="">Choose…</option>
            {BACKUP_PLACES.filter((p) => !(p.android === false && os !== 'ios')).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {place && (
          <ol className="small steps-list">
            {placeSteps(place, os).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        )}
        <p className={`small ${days == null || days > 7 ? 'warn-text' : 'muted'}`}>
          {last ? `Last backup: ${formatDate(last.toISOString().slice(0, 10))}${days ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ' (today)'}.` : 'No backup yet from this phone.'}
        </p>
        <button className="btn primary big block" onClick={() => void doBackup()} disabled={Boolean(busy)}>
          <Icon name="upload" size={18} />
          {busy === 'backup' ? 'Making the backup…' : 'Back up now'}
        </button>
        <p className="xs muted">
          Shap also keeps a safety copy inside the app, so a phone update or low storage doesn’t lose your books.{' '}
          {platform() === 'ios'
            ? 'If your iPhone backs up to iCloud, that copy goes along with it.'
            : platform() === 'android'
              ? 'If your phone backs up to Google, that copy usually goes along with it (Google keeps up to 25 MB per app).'
              : ''}{' '}
          Still back up here at least once a week: it’s a file you control, and it moves your books to a new phone, iPhone or Android.
        </p>
        {isNative() && (
          <label className="check">
            <input
              type="checkbox"
              checked={remind}
              onChange={(e) => {
                setRemind(e.target.checked);
                void scheduleBackupReminder(e.target.checked);
              }}
            />
            <span>
              Remind me a week after each backup
              <div className="xs muted">One notification, only when a backup is due.</div>
            </span>
          </label>
        )}
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
