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
  const r = await shareFile(new Blob([blob], { type: 'application/gzip' }), backupFilename(businessName), 'Back up your books', 'Shap Pocket backup');
  if (r !== 'cancelled') {
    try {
      localStorage.setItem(LAST, new Date().toISOString());
    } catch {
      /* fine */
    }
    void scheduleBackupReminder();
  }
  return r;
}

export async function restoreFrom(file: File) {
  await restore(file);
}

/* ---------- where backups go, and the weekly reminder ---------- */

export type BackupPlace = 'google' | 'onedrive' | 'dropbox' | 'icloud' | 'proton' | 'email';
const PLACE = 'shap.backupPlace';
const REMIND = 'shap.backupRemind';
const REMINDER_ID = 4201;

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
  if (os === 'web') return ['The backup downloads as one file.', `Drag it into ${place === 'email' ? 'an email to yourself' : app} (or move it from Downloads).`];
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
export const remindOn = () => store(REMIND) !== 'off';

/**
 * The reminder is a single phone notification a week after the last backup (or tomorrow
 * evening if there's never been one). Each backup moves it on a week, so nobody who backs up
 * gets nagged. Only on the phone apps; the web version has the reminder on Home.
 */
export async function scheduleBackupReminder(on = remindOn()) {
  store(REMIND, on ? 'on' : 'off');
  if (!isNative()) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });
    if (!on) return;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted' && (await LocalNotifications.requestPermissions()).display !== 'granted') return;
    const last = lastBackup();
    const at = new Date(last ? last.getTime() + 7 * 86_400_000 : Date.now() + 86_400_000);
    at.setHours(18, 0, 0, 0);
    if (at.getTime() < Date.now() + 60_000) at.setTime(Date.now() + 3_600_000);
    await LocalNotifications.schedule({
      notifications: [{ id: REMINDER_ID, title: 'Time to back up your books', body: 'Your books live only on this phone. One tap saves a copy to your cloud drive.', schedule: { at, allowWhileIdle: false }, extra: { open: '/backup' } }],
    });
  } catch {
    /* no notifications on this phone: the reminder on Home still works */
  }
}

/** A tap on the reminder opens the Backup screen. */
export async function listenForReminder(go: (path: string) => void) {
  if (!isNative()) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
      const to = (a.notification.extra as { open?: string } | undefined)?.open;
      if (to) go(to);
    });
  } catch {
    /* fine */
  }
}
