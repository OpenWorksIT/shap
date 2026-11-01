/**
 * The phone's own features: the share sheet (WhatsApp, Gmail, Outlook, Save to Files, Drive…),
 * opening a file, picking one. In a desktop browser (development) the same calls download.
 */
import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform() as 'ios' | 'android' | 'web';

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Writes the file to the app's cache and returns its native path. */
async function cacheFile(blob: Blob, filename: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = filename.replace(/[\\/:*?"<>|]/g, '-');
  const r = await Filesystem.writeFile({ path: `share/${safe}`, data: await toBase64(blob), directory: Directory.Cache, recursive: true });
  return r.uri;
}

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * The share sheet with this file: send a quote on WhatsApp or by email, or save a backup to
 * iCloud Drive, Google Drive, OneDrive or Proton Drive. Resolves 'shared', or 'cancelled' if
 * the person closed the sheet.
 */
export async function shareFile(blob: Blob, filename: string, title: string, text?: string): Promise<'shared' | 'cancelled' | 'downloaded'> {
  if (isNative()) {
    const { Share } = await import('@capacitor/share');
    try {
      await Share.share({ title, text, files: [await cacheFile(blob, filename)], dialogTitle: title });
      return 'shared';
    } catch (err) {
      if (/cancel/i.test(String((err as Error).message))) return 'cancelled';
      throw err;
    }
  }
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled';
    }
  }
  download(blob, filename);
  return 'downloaded';
}

/** Shows a file (a PDF, a slip photo) in the phone's viewer. */
export async function openFile(blob: Blob, filename: string): Promise<void> {
  if (isNative()) {
    // The share sheet's preview (iOS) or "Open with" (Android) is the phone's own viewer.
    await shareFile(blob, filename, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Lets the person choose a file (a backup to restore, a logo). */
export async function pickFile(accept: string[]): Promise<File | null> {
  if (isNative()) {
    const { FilePicker } = await import('@capawesome/capacitor-file-picker');
    const r = await FilePicker.pickFiles({ types: accept, limit: 1, readData: true });
    const f = r.files[0];
    if (!f?.data) return null;
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    return new File([bytes], f.name, { type: f.mimeType });
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
