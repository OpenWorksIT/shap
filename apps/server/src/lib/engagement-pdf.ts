/**
 * The practice's engagement letter, and a year's working papers, as PDFs (modules/working-papers.ts).
 * The letter is printed as it was drafted or sent, with lines to sign; the file is the practice's
 * record of its work on the year: its letter's standing, the trial balance's ticks, every review note
 * with its replies, and the sign-offs.
 */
import PDFDocument from 'pdfkit';
import { formatAmount, formatDate, SIGNOFF_WORDS, SIGNOFFS, type Signoff } from '@shap/shared';
import { usePdfFonts } from '../modules/pdf.js';
import type { LetterSection } from './engagement.js';

const INK = '#1d262c';
const MUTED = '#66737b';
const RULE = '#cfc8bd';

function start(title: string, author: string) {
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 56, right: 56 }, bufferPages: true, info: { Title: title, Author: author } });
  const fonts = usePdfFonts(pdf);
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  return { pdf, ...fonts, done, L: 56, W: pdf.page.width - 112 };
}

const day = (d: Date | string | null | undefined) => (d ? formatDate(typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10), 'long') : '');

export function renderLetterPdf(o: {
  practice: { name: string; address: string };
  client: string;
  letter: { status: string; body: LetterSection[]; sentAt: Date | null; acceptedOn: string | null; acceptedName: string | null; acceptedCapacity: string | null; acceptedHow: string | null };
}): Promise<Buffer> {
  const { pdf, regular, bold, done, L, W } = start(`Engagement letter: ${o.client}`, o.practice.name);
  pdf.font(bold).fontSize(13).fillColor(INK).text(o.practice.name, L);
  if (o.practice.address) pdf.font(regular).fontSize(9).fillColor(MUTED).text(o.practice.address, L, undefined, { width: W });
  pdf.moveDown(1.2);
  pdf.font(regular).fontSize(10).fillColor(INK).text(o.letter.sentAt ? day(o.letter.sentAt) : 'Draft: not sent yet', L);
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(10).text(`To ${o.client}`);
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(12).text('Engagement letter');
  for (const s of o.letter.body) {
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
  pdf.font(bold).fontSize(10).fillColor(INK).text(`For ${o.practice.name}`, L);
  line('Signature, name and date');
  pdf.moveDown(0.6);
  pdf.font(bold).fontSize(10).fillColor(INK).text(`Accepted for ${o.client}`, L);
  if (o.letter.status === 'accepted' && o.letter.acceptedName)
    pdf.font(regular).fontSize(9.5).text(`${o.letter.acceptedHow === 'signed' ? 'Signed' : 'Accepted'} by ${o.letter.acceptedName}${o.letter.acceptedCapacity ? `, ${o.letter.acceptedCapacity}` : ''}, on ${day(o.letter.acceptedOn)}${o.letter.acceptedHow === 'signed' ? ': the signed copy is kept with this letter in Shap.' : ' (recorded by the practice).'}`, L, undefined, { width: W });
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
  lines: { code: string; name: string; balanceCents: number; prepared: { by: string; at: Date | null; changed: boolean } | null; reviewed: { by: string; at: Date | null; changed: boolean; samePerson: boolean } | null }[] | null;
  gone: { code: string; name: string }[];
  notes: { account: { code: string; name: string | null } | null; text: string; raisedBy: string; raisedAt: Date; cleared: { by: string; at: Date | null } | null; replies: { text: string; by: string; at: Date }[] }[];
  signoffs: Record<Signoff, { by: string; at: Date; changed: boolean } | null>;
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

  h('Engagement letter');
  p(
    !f.letter.accepted
      ? 'No engagement letter accepted for this year is recorded.'
      : `${f.letter.compiling ? 'An accepted letter covers compiling the statements for this year' : 'An accepted letter covers this year, but not compiling the statements'}${f.letter.termsLooked ? '.' : '; its terms aren’t recorded as looked at again for this year.'}`,
  );

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
    const cols = { code: L, name: L + 50, bal: L + 250, prep: L + 330, rev: L + 410 };
    pdf.font(bold).fontSize(8).fillColor(MUTED);
    const y0 = pdf.y;
    pdf.text('Account', cols.code, y0).text('Balance', cols.bal, y0, { width: 70, align: 'right' }).text('Prepared', cols.prep, y0).text('Reviewed', cols.rev, y0);
    pdf.moveTo(L, pdf.y + 2).lineTo(R, pdf.y + 2).lineWidth(0.4).strokeColor(RULE).stroke();
    pdf.y += 5;
    for (const l of f.lines) {
      if (pdf.y > pdf.page.height - 90) pdf.addPage();
      const y = pdf.y;
      pdf.font(regular).fontSize(8).fillColor(INK);
      pdf.text(l.code, cols.code, y, { width: 48 });
      pdf.text(l.name, cols.name, y, { width: 196 });
      const after = pdf.y;
      pdf.text(formatAmount(l.balanceCents), cols.bal, y, { width: 70, align: 'right' });
      pdf.text(l.prepared ? `${l.prepared.by}${l.prepared.changed ? ' (changed)' : ''}` : '–', cols.prep, y, { width: 78 });
      pdf.text(l.reviewed ? `${l.reviewed.by}${l.reviewed.changed ? ' (changed)' : ''}` : '–', cols.rev, y, { width: 90 });
      pdf.y = Math.max(after, pdf.y) + 2;
    }
    if (f.gone.length) p(`Ticked before, with no balance at the year end now: ${f.gone.map((g) => `${g.code} ${g.name}`).join(', ')}.`, { muted: true });
  } else p('Their books are on their own Shap: their trial balance isn’t kept here.', { muted: true });

  pdf.moveDown(1);
  p('Shap records what the practice’s people tick, note and sign; it doesn’t check the work behind them.', { muted: true, size: 8 });
  pdf.end();
  return done;
}
