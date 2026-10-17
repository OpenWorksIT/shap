import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatDate, formatZar, LINE_CATEGORY_LABELS, type LineCategory } from '@shap/shared';
import type { SettingsRow } from '../lib/books.js';

export interface PdfDocument {
  doc: {
    id: string;
    kind: 'quote' | 'invoice';
    number: string;
    status: string;
    issueDate: string;
    dueDate: string | null;
    title: string;
    notes: string;
    terms: string;
    vatRateBp: number;
    subtotalCents: number;
    vatCents: number;
    totalCents: number;
    paidCents: number;
    paymentState: string | null;
    projectId: string | null;
    projectName: string | null;
    projectNumber: number | null;
    siteAddress: string | null;
    clientId: string | null;
    clientName: string | null;
    clientContact: string | null;
    clientAddress: string | null;
    clientEmail: string | null;
    clientPhone: string | null;
    clientVatNumber: string | null;
    clientCode: string | null;
    voidReason: string;
    sourceQuoteNumber: string | null;
  };
  lines: { id: string; category: LineCategory; description: string; qty: number; unit: string; unitPriceCents: number; lineTotalCents: number }[];
  settings: SettingsRow;
  logo: Buffer | null;
}

const INK = '#1f2b33';
const MUTED = '#5d6a72';
const RULE = '#d9d2c7';
const BAND = '#f4efe7';
const ACCENT = '#e8731c';

// Atkinson Hyperlegible (the app's typeface), from the fontsource package; Helvetica if it's missing.
const require = createRequire(import.meta.url);
function fontPath(weight: 400 | 700): string | null {
  try {
    const dir = require.resolve('@fontsource/atkinson-hyperlegible-next/package.json').replace(/package\.json$/, 'files/');
    const p = `${dir}atkinson-hyperlegible-next-latin-${weight}-normal.woff`;
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const REGULAR = fontPath(400);
const BOLD = fontPath(700);

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export function renderDocumentPdf(data: PdfDocument): Promise<Buffer> {
  const { doc, lines, settings, logo } = data;
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 56, left: 40, right: 40 }, bufferPages: true, info: { Title: `${doc.kind} ${doc.number}`, Author: settings.companyName } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const regular = REGULAR ? 'Body' : 'Helvetica';
  const bold = BOLD ? 'BodyBold' : 'Helvetica-Bold';
  if (REGULAR) pdf.registerFont('Body', REGULAR);
  if (BOLD) pdf.registerFont('BodyBold', BOLD);

  const W = pdf.page.width;
  const L = 40;
  const R = W - 40;
  const contentW = R - L;
  const bottom = () => pdf.page.height - 70;

  const isInvoice = doc.kind === 'invoice';
  const heading = isInvoice ? (settings.vatRegistered && doc.vatRateBp > 0 ? 'TAX INVOICE' : 'INVOICE') : 'QUOTATION';
  const company = settings.tradingName || settings.companyName;

  // ---- top band
  pdf.rect(0, 0, W, 6).fill(ACCENT);
  let y = 34;
  let logoBottom = y;
  if (logo) {
    try {
      pdf.image(logo, L, y, { fit: [150, 64] });
      logoBottom = y + 64;
    } catch {
      /* unreadable image: carry on without it */
    }
  }
  // company block, right aligned
  pdf.fillColor(INK).font(bold).fontSize(13).text(company, L, y, { width: contentW, align: 'right' });
  const companyLines = [
    settings.tradingName && settings.tradingName !== settings.companyName ? settings.companyName : '',
    settings.address,
    [settings.phone, settings.email].filter(Boolean).join('  ·  '),
    settings.website,
    settings.regNumber ? `Reg. no. ${settings.regNumber}` : '',
    settings.vatNumber && settings.vatRegistered ? `VAT no. ${settings.vatNumber}` : '',
  ].filter(Boolean);
  pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(companyLines.join('\n'), L, pdf.y + 2, { width: contentW, align: 'right', lineGap: 1 });
  y = Math.max(pdf.y, logoBottom) + 22;

  // ---- title and meta
  pdf.font(bold).fontSize(22).fillColor(INK).text(heading, L, y);
  if (doc.status === 'void') pdf.font(bold).fontSize(11).fillColor('#b42318').text(`VOID – ${doc.voidReason}`, L, pdf.y + 2);
  else if (doc.status === 'draft') pdf.font(bold).fontSize(10).fillColor(MUTED).text('DRAFT', L, pdf.y + 2);

  const meta: [string, string][] = [
    [isInvoice ? 'Invoice no.' : 'Quote no.', doc.number],
    ['Date', formatDate(doc.issueDate)],
  ];
  if (doc.dueDate) meta.push([isInvoice ? 'Due' : 'Valid until', formatDate(doc.dueDate)]);
  if (doc.clientCode) meta.push(['Account', doc.clientCode]);
  if (doc.sourceQuoteNumber) meta.push(['Quote', doc.sourceQuoteNumber]);
  let my = y + 2;
  for (const [k, v] of meta) {
    pdf.font(regular).fontSize(9).fillColor(MUTED).text(k, R - 210, my, { width: 90 });
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(v, R - 120, my, { width: 120, align: 'right' });
    my += 15;
  }
  y = Math.max(pdf.y, my) + 18;

  // ---- bill to / for
  const half = (contentW - 24) / 2;
  const label = (text: string, x: number, at: number) => pdf.font(bold).fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), x, at, { characterSpacing: 0.8 });
  label(isInvoice ? 'Bill to' : 'Prepared for', L, y);
  pdf.font(bold).fontSize(11).fillColor(INK).text(doc.clientName || '—', L, y + 12, { width: half });
  const clientLines = [doc.clientContact, doc.clientAddress, doc.clientPhone, doc.clientEmail, doc.clientVatNumber ? `VAT no. ${doc.clientVatNumber}` : ''].filter(Boolean) as string[];
  pdf.font(regular).fontSize(9).fillColor(INK).text(clientLines.join('\n'), L, pdf.y + 2, { width: half, lineGap: 1 });
  const leftBottom = pdf.y;
  let rightBottom = y;
  if (doc.title || doc.projectName) {
    label('For', L + half + 24, y);
    pdf.font(bold).fontSize(11).fillColor(INK).text(doc.title || doc.projectName || '', L + half + 24, y + 12, { width: half });
    const forLines = [doc.projectName && doc.title && doc.title !== doc.projectName ? `Job ${doc.projectNumber}: ${doc.projectName}` : doc.projectNumber ? `Job ${doc.projectNumber}` : '', doc.siteAddress].filter(Boolean) as string[];
    if (forLines.length) pdf.font(regular).fontSize(9).fillColor(INK).text(forLines.join('\n'), L + half + 24, pdf.y + 2, { width: half, lineGap: 1 });
    rightBottom = pdf.y;
  }
  y = Math.max(leftBottom, rightBottom) + 20;

  // ---- lines
  const cols = { desc: L + 8, qty: L + contentW - 250, unit: L + contentW - 185, amount: L + contentW - 95 };
  const tableHeader = () => {
    pdf.rect(L, y, contentW, 20).fill(BAND);
    pdf.font(bold).fontSize(8.5).fillColor(MUTED);
    pdf.text('Description', cols.desc, y + 6);
    pdf.text('Qty', cols.qty, y + 6, { width: 55, align: 'right' });
    pdf.text('Unit price', cols.unit, y + 6, { width: 80, align: 'right' });
    pdf.text('Amount', cols.amount, y + 6, { width: 87, align: 'right' });
    y += 26;
  };
  const ensure = (h: number) => {
    if (y + h > bottom()) {
      pdf.addPage();
      y = 48;
      tableHeader();
    }
  };
  tableHeader();

  const categories = [...new Set(lines.map((l) => l.category))];
  const grouped = categories.length > 1;
  for (const cat of categories) {
    const group = lines.filter((l) => l.category === cat);
    if (grouped) {
      ensure(22);
      pdf.font(bold).fontSize(9.5).fillColor(INK).text(LINE_CATEGORY_LABELS[cat], cols.desc, y);
      y = pdf.y + 4;
    }
    for (const l of group) {
      const descW = cols.qty - cols.desc - 12;
      pdf.font(regular).fontSize(9.5);
      const h = pdf.heightOfString(l.description, { width: descW });
      ensure(h + 8);
      pdf.fillColor(INK).text(l.description, cols.desc, y, { width: descW });
      pdf.text(`${qtyText(l.qty)}${l.unit ? ` ${l.unit}` : ''}`, cols.qty, y, { width: 55, align: 'right' });
      pdf.text(formatZar(l.unitPriceCents), cols.unit, y, { width: 80, align: 'right' });
      pdf.text(formatZar(l.lineTotalCents), cols.amount, y, { width: 87, align: 'right' });
      y += h + 6;
      pdf.moveTo(L, y - 2).lineTo(R, y - 2).lineWidth(0.5).strokeColor(RULE).stroke();
    }
    if (grouped) {
      const sub = group.reduce((s, l) => s + l.lineTotalCents, 0);
      ensure(18);
      pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(`${LINE_CATEGORY_LABELS[cat]} subtotal`, cols.unit - 80, y + 1, { width: 160, align: 'right' });
      pdf.font(bold).fontSize(9).fillColor(INK).text(formatZar(sub), cols.amount, y + 1, { width: 87, align: 'right' });
      y += 20;
    }
  }

  // ---- totals
  const totals: [string, number, boolean][] = [['Subtotal', doc.subtotalCents, false]];
  if (doc.vatRateBp > 0) totals.push([`VAT ${(doc.vatRateBp / 100).toFixed(doc.vatRateBp % 100 ? 1 : 0)}%`, doc.vatCents, false]);
  totals.push(['Total', doc.totalCents, true]);
  if (isInvoice && doc.paidCents) {
    totals.push(['Paid', -doc.paidCents, false]);
    totals.push(['Balance due', doc.totalCents - doc.paidCents, true]);
  }
  ensure(totals.length * 18 + 12);
  y += 6;
  for (const [k, v, strong] of totals) {
    if (strong) {
      pdf.rect(R - 230, y - 4, 230, 20).fill(k === 'Balance due' ? '#fde8d7' : BAND);
    }
    pdf.font(strong ? bold : regular).fontSize(strong ? 11 : 9.5).fillColor(INK);
    pdf.text(k, R - 222, y, { width: 120 });
    pdf.text(formatZar(v), R - 120, y, { width: 112, align: 'right' });
    y += strong ? 22 : 17;
  }
  y += 14;

  // ---- banking, notes, terms
  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    pdf.font(regular).fontSize(9);
    const h = pdf.heightOfString(body, { width: contentW }) + 20;
    if (y + h > bottom()) {
      pdf.addPage();
      y = 48;
    }
    label(title, L, y);
    pdf.font(regular).fontSize(9).fillColor(INK).text(body, L, y + 12, { width: contentW, lineGap: 1.5 });
    y = pdf.y + 14;
  };
  if (isInvoice) block('Banking details', settings.bankDetails + (settings.bankDetails ? `\nReference: ${doc.number}` : ''));
  block('Notes', doc.notes);
  block(isInvoice ? 'Terms' : 'Terms and conditions', doc.terms);

  // ---- footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    pdf.page.margins.bottom = 0;
    const fy = pdf.page.height - 38;
    pdf.moveTo(L, fy - 8).lineTo(R, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    const foot = [settings.companyName, settings.regNumber ? `Reg. ${settings.regNumber}` : '', settings.vatRegistered && settings.vatNumber ? `VAT ${settings.vatNumber}` : ''].filter(Boolean).join('  ·  ');
    pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(foot, L, fy, { width: contentW - 80, lineBreak: false });
    pdf.text(`Page ${i - range.start + 1} of ${range.count}`, R - 80, fy, { width: 80, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;
}
