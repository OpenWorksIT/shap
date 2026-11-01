/** Backups: the whole set of books as one file, saved wherever the person chooses. */
import { dump, restore } from '../pocket/engine';
import { shareFile } from './native';

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
  }
  return r;
}

export async function restoreFrom(file: File) {
  await restore(file);
}
