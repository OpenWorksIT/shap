/** A PDF from the books, shared from the phone (WhatsApp, email…) or saved. */
import { apiBlob } from './api';
import { shareFile } from './native';

export async function sharePdf(path: string, title: string, text?: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const { blob, filename } = await apiBlob(path);
  return shareFile(blob, filename, title, text);
}
