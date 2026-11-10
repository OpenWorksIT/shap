/** A PDF from the server, shared from a phone (WhatsApp, email…) or saved on a computer. */
import { apiBlob } from './api';

export async function sharePdf(path: string, title: string, text?: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const { blob, filename } = await apiBlob(path);
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await nav.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return 'downloaded';
}
