/** Backups: the whole set of books as one file, saved wherever the person chooses. */
import { dump, restore } from '../pocket/engine';
import { isNative, shareFile } from './native';

const LAST = 'shap.lastBackup';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/** When the books were last backed up off the phone (as far as this phone knows). */
export function lastBackup(): Date | null {
  const v = read(LAST);
  return v ? new Date(v) : null;
}

export const backupFilename = (name: string, d = new Date()) =>
  `${(name || 'Shap Pocket').replace(/[^\w -]/g, '').trim() || 'Shap Pocket'} backup ${d.toISOString().slice(0, 10)}.tar.gz`;

/**
 * Opens the share sheet with today's backup: Save to Files → iCloud Drive, Google Drive,
 * OneDrive or Proton Drive (whichever is set up on the phone), or any app that takes files.
 */
export async function backUp(businessName: string): Promise<'shared' | 'cancelled' | 'downloaded'> {
  const blob = await dump();
  const file = new Blob([blob], { type: 'application/gzip' });
  const r = !isNative() && 'showSaveFilePicker' in window ? await saveWithPicker(file, backupFilename(businessName)) : await shareFile(file, backupFilename(businessName), 'Back up your books', 'Shap Pocket backup');
  if (r !== 'cancelled') {
    try {
      localStorage.setItem(LAST, new Date().toISOString());
    } catch {
      /* fine */
    }
  }
  return r;
}

/**
 * On a computer (Edge, Chrome): a Save dialog, so the backup can go straight into the OneDrive or
 * Google Drive folder. The browser remembers the folder for next time.
 */
async function saveWithPicker(file: Blob, name: string): Promise<'downloaded' | 'cancelled'> {
  type Picker = (o: object) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  try {
    const handle = await (window as unknown as { showSaveFilePicker: Picker }).showSaveFilePicker({
      suggestedName: name,
      id: 'shap-backups',
      startIn: 'documents',
      types: [{ description: 'Shap Pocket backup', accept: { 'application/gzip': ['.gz'] } }],
    });
    const w = await handle.createWritable();
    await w.write(file);
    await w.close();
    return 'downloaded';
  } catch (err) {
    if ((err as Error).name === 'AbortError') return 'cancelled';
    // Not allowed here (some browsers, private windows): an ordinary download.
    return (await shareFile(file, name, 'Back up your books', 'Shap Pocket backup')) === 'cancelled' ? 'cancelled' : 'downloaded';
  }
}

export async function restoreFrom(file: File) {
  await restore(file);
}

/* ---------- where backups go ---------- */

export type BackupPlace = 'google' | 'onedrive' | 'dropbox' | 'icloud' | 'proton' | 'email';
const PLACE = 'shap.backupPlace';

export const BACKUP_PLACES: { key: BackupPlace; label: string; ios?: boolean; android?: boolean }[] = [
  { key: 'google', label: 'Google Drive' },
  { key: 'icloud', label: 'iCloud Drive', android: false },
  { key: 'onedrive', label: 'OneDrive' },
  { key: 'dropbox', label: 'Dropbox' },
  { key: 'proton', label: 'Proton Drive' },
  { key: 'email', label: 'Email it to myself' },
];

/** Step by step for each place, for this kind of phone. */
export function placeSteps(place: BackupPlace, os: 'ios' | 'android' | 'web'): string[] {
  const app = { google: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', proton: 'Proton Drive', icloud: 'iCloud Drive', email: '' }[place];
  if (os === 'web')
    return place === 'email'
      ? ['Click Back up now: the backup is saved as one file.', 'Attach it to an email to yourself.', 'Fine for a start, but a cloud drive keeps every copy tidy in one folder.']
      : [
          `Install ${app} for your computer and sign in (${place === 'onedrive' ? 'Windows usually has it already' : place === 'google' ? 'Google Drive for desktop' : place === 'proton' ? 'Proton Drive for Windows' : 'the Dropbox app'}): it adds a ${app} folder that copies itself to the cloud.`,
          `Click Back up now and save the file in that ${app} folder (make a folder called “Shap backups”). Next time the browser remembers the folder.`,
        ];
  if (place === 'email') return ['Tap Back up now: your phone’s share menu opens.', 'Choose Gmail or Mail and send it to yourself.', 'Fine for a start, but a cloud drive keeps every copy tidy in one folder.'];
  if (place === 'icloud') return ['Make sure iCloud Drive is on: Settings → your name → iCloud → iCloud Drive.', 'Tap Back up now, then Save to Files.', 'Choose iCloud Drive, make a folder called “Shap backups”, and tap Save.'];
  const install = `Install ${app} from the ${os === 'ios' ? 'App Store' : 'Play Store'} and sign in${place === 'google' && os === 'android' ? ' (most Android phones already have it)' : ''}.`;
  return os === 'ios'
    ? [install, 'Tap Back up now, then Save to Files.', `Tap ${app} in the list (switch it on under “Edit” if it isn’t there), pick a folder like “Shap backups”, and tap Save.`]
    : [install, `Tap Back up now: your phone’s share menu opens. Tap ${app}${place === 'google' ? ' (it may say “Save to Drive”)' : ''}.`, 'Pick a folder like “Shap backups” and tap Save. Next time it remembers the folder.'];
}

/** The phone's own backup, which also carries Shap's safety copy. */
export function phoneBackupTip(os: 'ios' | 'android' | 'web'): string {
  if (os === 'ios') return 'Also switch on iCloud Backup (Settings → your name → iCloud → iCloud Backup): Shap’s safety copy goes along with it.';
  if (os === 'android') return 'Also switch on your phone’s own backup (Settings → Google → Backup): Shap’s safety copy usually goes along with it.';
  return '';
}

const store = (k: string, v?: string | null) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
  return null;
};

export const backupPlace = () => store(PLACE) as BackupPlace | null;
export const setBackupPlace = (p: BackupPlace | null) => void store(PLACE, p);

