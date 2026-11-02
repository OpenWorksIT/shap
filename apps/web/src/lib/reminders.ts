/**
 * Payment reminders: emailed from the server with the invoice attached (when email is set up and
 * the client has an address), or the PDF shared (phones) or downloaded with the message copied,
 * ready to paste into WhatsApp or an email. Either way it's noted on the invoice, so Home knows
 * when the client was last reminded.
 */
import { formatDate, formatZar } from '@shap/shared';
import { api, apiBlob } from './api';
import type { Settings } from './types';

export interface Remindable {
  id: string;
  number: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  clientName?: string | null;
  clientEmail?: string | null;
  payLink?: string | null;
  reminders?: number;
}

/** The message: what's owed, since when, and the quick ways to pay. */
export function reminderText(inv: Remindable, settings: Settings, payshap: boolean): string {
  const owing = Number(inv.totalCents) - Number(inv.paidCents);
  const from = settings.tradingName || settings.companyName;
  const part = Number(inv.paidCents) > 0 ? ` (${formatZar(owing)} of the ${formatZar(Number(inv.totalCents))} is still to pay)` : '';
  const ways = [
    payshap && settings.payshapId ? `Pay instantly with PayShap to ${settings.payshapId} (reference ${inv.number}).` : '',
    inv.payLink || settings.payLink ? `Pay by card: ${inv.payLink || settings.payLink}` : '',
  ].filter(Boolean);
  const again = (inv.reminders ?? 0) > 0;
  return [
    `Good day${inv.clientName ? ` ${inv.clientName}` : ''},`,
    `${again ? 'Just following up: ' : 'A friendly reminder that '}invoice ${inv.number}${Number(inv.paidCents) > 0 ? '' : ` for ${formatZar(owing)}`}${inv.dueDate ? `, due on ${formatDate(inv.dueDate)},` : ''} is still open${part}. I’ve attached it again for easy reference.`,
    ways.length ? ways.join('\n') : 'The banking details are on the invoice.',
    'If you’ve already paid, please ignore this and send me the proof of payment. Thank you!',
    `Kind regards,\n${from}`,
  ].join('\n\n');
}

/**
 * Sends the reminder: by email from the server when it can, otherwise the PDF to the share sheet
 * (phones) or downloaded, with the message on the clipboard. Says what happened, or null if cancelled.
 */
export async function sendReminder(
  inv: Remindable,
  settings: Settings,
  opts: { payshap: boolean; emailOn: boolean },
): Promise<'emailed' | 'shared' | 'downloaded' | null> {
  const text = reminderText(inv, settings, opts.payshap);
  if (opts.emailOn && inv.clientEmail) {
    await api(`/api/documents/${inv.id}/email`, { body: { to: inv.clientEmail, message: text } });
    await api(`/api/documents/${inv.id}/reminded`, { body: {} });
    return 'emailed';
  }
  const { blob, filename } = await apiBlob(`/api/documents/${inv.id}/pdf`);
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  let how: 'shared' | 'downloaded' = 'downloaded';
  if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await nav.share({ files: [file], title: `Reminder: invoice ${inv.number}`, text });
      how = 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
    }
  }
  if (how === 'downloaded') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* no clipboard: the PDF still downloaded */
    }
  }
  await api(`/api/documents/${inv.id}/reminded`, { body: {} });
  return how;
}

export const reminderToast = (how: 'emailed' | 'shared' | 'downloaded', inv: { number: string; clientEmail?: string | null }) =>
  how === 'emailed' ? `Reminder for ${inv.number} emailed to ${inv.clientEmail}` : how === 'shared' ? `Reminder for ${inv.number} sent` : `Invoice ${inv.number} downloaded and the reminder copied: paste it into WhatsApp or your email`;
