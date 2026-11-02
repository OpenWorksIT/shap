/**
 * Payment reminders: the invoice's PDF to the share sheet (WhatsApp, email, SMS…) with a polite
 * message already written, then noted on the invoice so Home knows when the client was last reminded.
 */
import { formatDate, formatZar } from '@shap/shared';
import { api, apiBlob } from './api';
import { shareFile } from './native';
import type { Settings } from './types';

export interface Remindable {
  id: string;
  number: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  clientName?: string | null;
  payLink?: string | null;
  reminders?: number;
}

/** The message under the PDF: what's owed, since when, and the quick ways to pay. */
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

/** Opens the share sheet with the invoice and the reminder. True when it was sent (not cancelled). */
export async function sendReminder(inv: Remindable, settings: Settings, payshap: boolean): Promise<boolean> {
  const { blob, filename } = await apiBlob(`/api/documents/${inv.id}/pdf`);
  const how = await shareFile(blob, filename, `Reminder: invoice ${inv.number}`, reminderText(inv, settings, payshap));
  if (how === 'cancelled') return false;
  await api(`/api/documents/${inv.id}/reminded`, { body: {} });
  return true;
}
