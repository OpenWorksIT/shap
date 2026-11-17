/**
 * The practice's engagement letter, and a year's working papers, as PDFs (modules/working-papers.ts).
 * The letter is printed as it was drafted or sent, headed by its parties as the letter keeps them
 * (never read afresh, so a sent letter's PDF doesn't change when anyone is renamed), with lines to
 * sign. A draft says it isn't for sending and carries LETTER_NOTE; a sent letter is the practice's
 * own to its client, and brings in nothing of OpenWorks. The file is the practice's record of its
 * work on the year: its letter's standing, the statements' dates, the trial balance's ticks, every
 * review note with its replies, and the sign-offs.
 */
import PDFDocument from 'pdfkit';
import { formatAmount, formatDate, SIGNOFF_WORDS, SIGNOFFS, type Signoff } from '@shap/shared';
import { usePdfFonts } from '../modules/pdf.js';
import type { LetterSection } from './engagement.js';

const INK = '#1d262c';
const MUTED = '#66737b';
const RULE = '#cfc8bd';
const WARN = '#8a4b0f';

function start(title: string, author: string) {
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 56, right: 56 }, bufferPages: true, info: { Title: title, Author: author } });
  const fonts = usePdfFonts(pdf);
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  return { pdf, ...fonts, done, L: 56, W: pdf.page.width - 112 };
}

const day = (d: Date | string | null | undefined) => (d ? formatDate(typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10), 'long') : '');

export interface LetterForPdf {
  status: string;
  body: LetterSection[];
  /** The day it was sent, in South Africa. */
  sentDay: string | null;
  practiceName: string;
  practiceReg: string;
  practiceTrading: string;
  practiceAddress: string;
  clientName: string;
  acceptedOn: string | null;
  acceptedName: string | null;
  acceptedCapacity: string | null;
  acceptedHow: string | null;
}

export function renderLetterPdf(o: { letter: LetterForPdf; draftNote: string }): Promise<Buffer> {
  const l = o.letter;
  const draft = l.status === 'draft';
  const { pdf, regular, bold, done, L, W } = start(`Engagement letter: ${l.clientName}${draft ? ' (draft)' : ''}`, l.practiceName);
  pdf.font(bold).fontSize(13).fillColor(INK).text(l.practiceName, L, undefined, { width: W });
  const ids = [l.practiceReg ? `Registration number ${l.practiceReg}` : '', l.practiceTrading ? `Trading as ${l.practiceTrading}` : ''].filter(Boolean).join(' · ');
  if (ids) pdf.font(regular).fontSize(9).fillColor(MUTED).text(ids, L, undefined, { width: W });
  if (l.practiceAddress) pdf.font(regular).fontSize(9).fillColor(MUTED).text(l.practiceAddress, L, undefined, { width: W });
  pdf.moveDown(1.2);
  if (draft) {
    pdf.font(bold).fontSize(11).fillColor(WARN).text('Draft, to read: not for sending', L);
    pdf.font(regular).fontSize(8.5).fillColor(WARN).text(o.draftNote, L, undefined, { width: W });
  } else pdf.font(regular).fontSize(10).fillColor(INK).text(day(l.sentDay), L);
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(10).fillColor(INK).text(`To ${l.clientName}`, L, undefined, { width: W });
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(12).text('Engagement letter');
  for (const s of l.body) {
    pdf.moveDown(0.7);
    if (s.heading) pdf.font(bold).fontSize(10.5).fillColor(INK).text(s.heading, L, undefined, { width: W });
    for (const p of s.paragraphs) pdf.font(regular).fontSize(9.5).fillColor(INK).text(p, L, undefined, { width: W, paragraphGap: 4, align: 'left' });
  }
  pdf.moveDown(1.5);
  const line = (label: string) => {
    pdf.moveTo(L, pdf.y + 18).lineTo(L + 240, pdf.y + 18).lineWidth(0.6).strokeColor(INK).stroke();
    pdf.y += 22;
    pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(label, L);
    pdf.moveDown(0.4);
  };
  pdf.font(bold).fontSize(10).fillColor(INK).text(`For ${l.practiceName}`, L, undefined, { width: W });
  line('Signature, name and date');
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(10).fillColor(INK).text(`Accepted for ${l.clientName}`, L, undefined, { width: W });
  if ((l.status === 'accepted' || l.status === 'ended') && l.acceptedName)
    pdf.font(regular).fontSize(9.5).text(`${l.acceptedHow === 'signed' ? 'Signed' : 'Accepted'} by ${l.acceptedName}${l.acceptedCapacity ? `, ${l.acceptedCapacity}` : ''}, on ${day(l.acceptedOn)}${l.acceptedHow === 'signed' ? ': the signed copy is kept with this letter.' : ' (recorded by the practice).'}`, L, undefined, { width: W });
  else {
    line('Signature');
    line('Name and capacity (director, member, partner, trustee or owner)');
    line('Date');
  }
  pdf.end();
  return done;
}

export interface FileForPdf {
  client: { name: string; kind: string };
  fyEnd: string;
  letter: { accepted: boolean; compiling: boolean; termsLooked: boolean };
  statements: { status: string; compiledOn: string | null; approvedOn: string | null } | null;
  lines: { code: string; name: string; debitCents: number; creditCents: number; prepared: { by: string; at: Date | null; changed: boolean } | null; reviewed: { by: string; at: Date | null; changed: boolean; samePerson: boolean } | null }[] | null;
  totals: { debitCents: number; creditCents: number; differenceCents: number } | null;
  gone: { code: string; name: string }[];
  notes: { account: { code: string; name: string | null } | null; text: string; raisedBy: string; raisedAt: Date; cleared: { by: string; at: Date | null } | null; replies: { text: string; by: string; at: Date }[] }[];
  signoffs: Record<Signoff, { by: string; at: Date; changed: boolean } | null>;
}

/** What the file says of the year's statements, and the copy of them the practice keeps with it (ISRS 4410 (Revised) para 38(c)). */
export function statementsLine(f: Pick<FileForPdf, 'statements' | 'client'>): string {
  if (!f.statements)
    return 'Their books and statements are on their own Shap: download the signed set and the compilation report there, and keep them with this file (ISRS 4410 (Revised) para 38(c)). They aren’t here once they unlink you.';
  const s = f.statements;
  const dates = [s.compiledOn ? `compiled on ${day(s.compiledOn)}` : 'not compiled yet', s.approvedOn ? `approved on ${day(s.approvedOn)}` : 'not approved yet'].join(', ');
  // A Shap Pocket client's books stay on their phone or computer (what's here is a copy of their share); anyone else's here go back to them.
  const why = f.client.kind === 'pocket' ? 'what’s here is a copy of their Shap Pocket share' : 'their books go back to them when the engagement ends';
  return `The statements: ${dates}. Keep a copy of the final set and the compilation report with this file (ISRS 4410 (Revised) para 38(c)): ${why}.`;
}

export function renderFilePdf(o: { practice: string; file: FileForPdf }): Promise<Buffer> {
  const f = o.file;
  const { pdf, regular, bold, done, L, W } = start(`Working papers: ${f.client.name}, the year to ${f.fyEnd}`, o.practice);
  const R = L + W;
  const h = (t: string) => {
    pdf.moveDown(0.9);
    pdf.font(bold).fontSize(11).fillColor(INK).text(t, L);
    pdf.moveDown(0.3);
  };
  const p = (t: string, opts: { muted?: boolean; size?: number } = {}) =>
    pdf.font(regular).fontSize(opts.size ?? 9).fillColor(opts.muted ? MUTED : INK).text(t, L, undefined, { width: W, paragraphGap: 2 });

  pdf.font(bold).fontSize(14).fillColor(INK).text(`Working papers: ${f.client.name}`, L);
  pdf.font(regular).fontSize(9.5).fillColor(MUTED).text(`The year to ${day(f.fyEnd)}. ${o.practice}’s own record, made in Shap Accountant on ${day(new Date())}.`);

  h('Sign-offs');
  for (const r of SIGNOFFS) {
    const s = f.signoffs[r];
    p(`${SIGNOFF_WORDS[r]}: ${s ? `${s.by}, ${day(s.at)}${s.changed ? ' (the books have changed since)' : ''}` : 'not yet'}`);
  }
  if (f.signoffs.partner && !f.signoffs.reviewed) p('The engagement partner signed off with no review recorded.', { muted: true });

  h('Engagement letter');
  p(
    !f.letter.accepted
      ? 'No engagement letter accepted for this year is recorded.'
      : `${f.letter.compiling ? 'An accepted letter covers compiling the statements for this year' : 'An accepted letter covers this year, but not compiling the statements'}${f.letter.termsLooked ? '.' : '; its terms aren’t recorded as looked at again for this year.'}`,
  );

  h('The statements');
  p(statementsLine(f));

  h('Review notes');
  if (!f.notes.length) p('None.', { muted: true });
  for (const n of f.notes) {
    pdf.moveDown(0.3);
    pdf.font(bold).fontSize(9).fillColor(INK).text(`${n.account ? `${n.account.code} ${n.account.name ?? ''}: ` : ''}${n.cleared ? 'cleared' : 'open'}`, L, undefined, { width: W });
    p(`${n.text} (${n.raisedBy}, ${day(n.raisedAt)})`);
    for (const r of n.replies) p(`  ${r.by}, ${day(r.at)}: ${r.text}`);
    if (n.cleared) p(`  Cleared by ${n.cleared.by}, ${day(n.cleared.at)}.`, { muted: true });
  }

  if (f.lines) {
    h('Trial balance at the year end');
    const cols = { code: L, name: L + 44, dr: L + 214, cr: L + 280, prep: L + 352, rev: L + 422 };
    pdf.font(bold).fontSize(8).fillColor(MUTED);
    const y0 = pdf.y;
    pdf.text('Account', cols.code, y0).text('Debit', cols.dr, y0, { width: 62, align: 'right' }).text('Credit', cols.cr, y0, { width: 62, align: 'right' }).text('Prepared', cols.prep, y0).text('Reviewed', cols.rev, y0);
    pdf.moveTo(L, pdf.y + 2).lineTo(R, pdf.y + 2).lineWidth(0.4).strokeColor(RULE).stroke();
    pdf.y += 5;
    for (const l of f.lines) {
      if (pdf.y > pdf.page.height - 90) pdf.addPage();
      const y = pdf.y;
      pdf.font(regular).fontSize(8).fillColor(INK);
      pdf.text(l.code, cols.code, y, { width: 42 });
      pdf.text(l.name, cols.name, y, { width: 166 });
      const after = pdf.y;
      pdf.text(l.debitCents ? formatAmount(l.debitCents) : '', cols.dr, y, { width: 62, align: 'right' });
      pdf.text(l.creditCents ? formatAmount(l.creditCents) : '', cols.cr, y, { width: 62, align: 'right' });
      pdf.text(l.prepared ? `${l.prepared.by}${l.prepared.changed ? ' (changed)' : ''}` : '–', cols.prep, y, { width: 66 });
      pdf.text(l.reviewed ? `${l.reviewed.by}${l.reviewed.changed ? ' (changed)' : ''}` : '–', cols.rev, y, { width: R - cols.rev });
      pdf.y = Math.max(after, pdf.y) + 2;
    }
    if (f.totals) {
      pdf.moveTo(L, pdf.y + 1).lineTo(R, pdf.y + 1).lineWidth(0.4).strokeColor(RULE).stroke();
      pdf.y += 4;
      const y = pdf.y;
      pdf.font(bold).fontSize(8).fillColor(INK).text('Total', cols.name, y, { width: 166 });
      pdf.text(formatAmount(f.totals.debitCents), cols.dr, y, { width: 62, align: 'right' }).text(formatAmount(f.totals.creditCents), cols.cr, y, { width: 62, align: 'right' });
      pdf.moveDown(0.4);
      if (f.totals.differenceCents !== 0) p(`It doesn’t balance: debits and credits differ by ${formatAmount(Math.abs(f.totals.differenceCents))}.`);
    }
    if (f.gone.length) p(`Ticked before, with no balance at the year end now: ${f.gone.map((g) => `${g.code} ${g.name}`).join(', ')}.`, { muted: true });
  } else p('Their books are on their own Shap: their trial balance isn’t kept here.', { muted: true });

  pdf.moveDown(1);
  p('Shap records what the practice’s people tick, note and sign; it doesn’t check the work behind them. This file is an aid towards the practice’s record of the engagement (ISRS 4410 (Revised) para 38), not the whole of it.', { muted: true, size: 8 });
  pdf.end();
  return done;
}
