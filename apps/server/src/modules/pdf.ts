import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatDate, formatZar, LINE_CATEGORY_LABELS, type LineCategory } from '@shap/shared';
import type { SettingsRow } from '../lib/books.js';

export interface BrandRow {
  id: string;
  name: string;
  legalLine: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  bankDetails: string;
  logoId: string | null;
  accent: string;
  active: boolean;
}

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
    brandId: string | null;
    brandName: string | null;
    depositBp: number | null;
    depositCents: number | null;
    depositShowBalance: boolean;
    depositDueCents: number;
    writtenOffOn: string | null;
    writtenOffCents: number;
    writtenOffReason: string;
  };
  lines: { id: string; category: LineCategory; description: string; qty: number; unit: string; unitPriceCents: number; lineTotalCents: number }[];
  settings: SettingsRow;
  brand: BrandRow | null;
  logo: Buffer | null;
}

const INK = '#1d262c';
const MUTED = '#66737b';
const RULE = '#e2ddd5';
const ZEBRA = '#faf8f5';

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

/** A pale tint of the brand colour for bands and boxes. */
function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Quote / invoice layout: the trading name's logo and colour, the document's essentials
 * (number, date, amount due) where the eye lands first, and the bank details in a box
 * at the bottom so paying is easy.
 */
export function renderDocumentPdf(data: PdfDocument): Promise<Buffer> {
  const { doc, lines, settings, brand, logo } = data;
  const accent = brand?.accent && /^#[0-9a-f]{6}$/i.test(brand.accent) ? brand.accent : '#e8731c';
  const soft = tint(accent, 0.9);
  const tradingName = brand?.name || settings.tradingName || settings.companyName;
  const legal = brand?.legalLine || (tradingName !== settings.companyName ? `${settings.companyName} t/a ${tradingName}` : settings.companyName);
  const contact = {
    address: brand?.address || settings.address,
    phone: brand?.phone || settings.phone,
    email: brand?.email || settings.email,
    website: brand?.website || settings.website,
    bank: brand?.bankDetails || settings.bankDetails,
  };

  const pdf = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 60, left: 44, right: 44 }, bufferPages: true, info: { Title: `${doc.kind === 'invoice' ? 'Invoice' : 'Quote'} ${doc.number}`, Author: tradingName } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const regular = REGULAR ? 'Body' : 'Helvetica';
  const bold = BOLD ? 'BodyBold' : 'Helvetica-Bold';
  if (REGULAR) pdf.registerFont('Body', REGULAR);
  if (BOLD) pdf.registerFont('BodyBold', BOLD);

  const W = pdf.page.width;
  const L = 44;
  const R = W - 44;
  const contentW = R - L;
  const bottom = () => pdf.page.height - 74;
  const isInvoice = doc.kind === 'invoice';
  const heading = isInvoice ? (settings.vatRegistered && doc.vatRateBp > 0 ? 'Tax invoice' : 'Invoice') : 'Quotation';
  const balance = doc.totalCents - (isInvoice ? doc.paidCents : 0);
  const label = (text: string, x: number, at: number, opts: PDFKit.Mixins.TextOptions = {}) =>
    pdf.font(bold).fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), x, at, { characterSpacing: 0.9, ...opts });

  // ---- header: logo left, title and essentials right
  let y = 40;
  let logoBottom = y;
  if (logo) {
    try {
      pdf.image(logo, L, y, { fit: [210, 78] });
      logoBottom = y + 78;
    } catch {
      /* unreadable image: carry on without it */
    }
  }
  if (!logo) {
    pdf.font(bold).fontSize(20).fillColor(accent).text(tradingName, L, y + 6, { width: 260 });
    logoBottom = pdf.y;
  }
  pdf.font(bold).fontSize(26).fillColor(accent).text(heading, L, y, { width: contentW, align: 'right' });
  const meta: [string, string][] = [
    [isInvoice ? 'Invoice no.' : 'Quote no.', doc.number],
    ['Date', formatDate(doc.issueDate)],
  ];
  if (doc.dueDate) meta.push([isInvoice ? 'Due' : 'Valid until', formatDate(doc.dueDate)]);
  if (doc.clientCode) meta.push(['Account', doc.clientCode]);
  if (doc.sourceQuoteNumber) meta.push(['Our quote', doc.sourceQuoteNumber]);
  let my = y + 36;
  for (const [k, v] of meta) {
    pdf.font(regular).fontSize(9).fillColor(MUTED).text(k, R - 200, my, { width: 90, align: 'right' });
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(v, R - 100, my, { width: 100, align: 'right' });
    my += 14;
  }
  if (doc.status === 'void') {
    pdf.font(bold).fontSize(10).fillColor('#b42318').text(`VOID — ${doc.voidReason}`, R - 260, my + 2, { width: 260, align: 'right' });
    my += 16;
  } else if (doc.status === 'draft') {
    pdf.font(bold).fontSize(9).fillColor(MUTED).text('DRAFT', R - 200, my + 2, { width: 200, align: 'right' });
    my += 14;
  }
  y = Math.max(logoBottom, my) + 22;

  // ---- from / to band
  const colW = (contentW - 30) / 2;
  const bandTop = y;
  pdf.rect(L, bandTop, contentW, 2).fill(accent);
  y = bandTop + 14;
  label('From', L, y);
  label(isInvoice ? 'Bill to' : 'Prepared for', L + colW + 30, y);
  y += 12;
  pdf.font(bold).fontSize(10.5).fillColor(INK).text(tradingName, L, y, { width: colW });
  const fromLines = [
    legal !== tradingName ? legal : '',
    settings.regNumber ? `Reg. no. ${settings.regNumber}` : '',
    settings.vatRegistered && settings.vatNumber ? `VAT no. ${settings.vatNumber}` : '',
    contact.address,
    [contact.phone, contact.email].filter(Boolean).join('  ·  '),
    contact.website,
  ].filter(Boolean);
  pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(fromLines.join('\n'), L, pdf.y + 2, { width: colW, lineGap: 1.2 });
  const fromBottom = pdf.y;
  pdf.font(bold).fontSize(10.5).fillColor(INK).text(doc.clientName || '—', L + colW + 30, y, { width: colW });
  const toLines = [doc.clientContact && doc.clientContact !== doc.clientName ? doc.clientContact : '', doc.clientAddress, [doc.clientPhone, doc.clientEmail].filter(Boolean).join('  ·  '), doc.clientVatNumber ? `VAT no. ${doc.clientVatNumber}` : ''].filter(Boolean) as string[];
  pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(toLines.join('\n'), L + colW + 30, pdf.y + 2, { width: colW, lineGap: 1.2 });
  y = Math.max(fromBottom, pdf.y) + 16;

  // ---- what it's for
  const forText = doc.title || doc.projectName || '';
  if (forText) {
    pdf.font(regular).fontSize(9);
    const site = doc.siteAddress ? `  ·  ${doc.siteAddress}` : '';
    const h = pdf.heightOfString(`${forText}${site}`, { width: contentW - 70 }) + 14;
    pdf.roundedRect(L, y, contentW, h, 4).fill(soft);
    label('For', L + 12, y + 8);
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(forText, L + 52, y + 7, { width: contentW - 64, continued: Boolean(site) });
    if (site) pdf.font(regular).fillColor(MUTED).text(site);
    y += h + 14;
  }

  // ---- lines
  const cols = { desc: L + 10, qty: R - 250, unit: R - 182, amount: R - 92 };
  const tableHeader = () => {
    pdf.font(bold).fontSize(8).fillColor(MUTED);
    pdf.text('DESCRIPTION', cols.desc, y, { characterSpacing: 0.6 });
    pdf.text('QTY', cols.qty, y, { width: 55, align: 'right', characterSpacing: 0.6 });
    pdf.text('UNIT PRICE', cols.unit, y, { width: 80, align: 'right', characterSpacing: 0.6 });
    pdf.text('AMOUNT', cols.amount, y, { width: 82, align: 'right', characterSpacing: 0.6 });
    y += 13;
    pdf.moveTo(L, y).lineTo(R, y).lineWidth(1.2).strokeColor(accent).stroke();
    y += 6;
  };
  const ensure = (h: number) => {
    if (y + h > bottom()) {
      pdf.addPage();
      y = 50;
      tableHeader();
    }
  };
  tableHeader();

  const categories = [...new Set(lines.map((l) => l.category))];
  const grouped = categories.length > 1;
  let row = 0;
  for (const cat of categories) {
    const group = lines.filter((l) => l.category === cat);
    if (grouped) {
      ensure(24);
      pdf.font(bold).fontSize(8).fillColor(accent).text(LINE_CATEGORY_LABELS[cat].toUpperCase(), cols.desc, y + 4, { characterSpacing: 0.8 });
      y = pdf.y + 5;
    }
    for (const l of group) {
      const descW = cols.qty - cols.desc - 14;
      pdf.font(regular).fontSize(9.5);
      const h = pdf.heightOfString(l.description, { width: descW }) + 12;
      ensure(h);
      if (row++ % 2 === 1) pdf.rect(L, y, contentW, h).fill(ZEBRA);
      pdf.fillColor(INK).text(l.description, cols.desc, y + 6, { width: descW });
      pdf.text(`${qtyText(l.qty)}${l.unit ? ` ${l.unit}` : ''}`, cols.qty, y + 6, { width: 55, align: 'right' });
      pdf.text(formatZar(l.unitPriceCents), cols.unit, y + 6, { width: 80, align: 'right' });
      pdf.font(bold).text(formatZar(l.lineTotalCents), cols.amount, y + 6, { width: 82, align: 'right' });
      y += h;
    }
  }
  pdf.moveTo(L, y + 2).lineTo(R, y + 2).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 14;

  // ---- totals (right) and payment details (left), side by side
  const totals: [string, number][] = [];
  if (grouped) for (const cat of categories) totals.push([LINE_CATEGORY_LABELS[cat], lines.filter((l) => l.category === cat).reduce((s, l) => s + l.lineTotalCents, 0)]);
  totals.push(['Subtotal', doc.subtotalCents]);
  if (doc.vatRateBp > 0) totals.push([`VAT ${(doc.vatRateBp / 100).toFixed(doc.vatRateBp % 100 ? 1 : 0)}%`, doc.vatCents]);
  // A deposit is a request for part of the total up front. On an invoice it's what's due until it's in.
  const deposit = Math.min(doc.depositDueCents ?? 0, doc.totalCents);
  const depositLabel = `Deposit${doc.depositBp ? ` (${(doc.depositBp / 100).toFixed(doc.depositBp % 100 ? 1 : 0)}%)` : ''}`;
  const depositDue = isInvoice && deposit > 0 && doc.paidCents < deposit;
  if (deposit > 0 && (!isInvoice || depositDue)) {
    totals.push(['Total', doc.totalCents]);
    totals.push([isInvoice ? `${depositLabel} due now` : `${depositLabel} to confirm`, deposit]);
    if (doc.paidCents) totals.push(['Paid', -doc.paidCents]);
    if (!isInvoice || doc.depositShowBalance) totals.push([isInvoice ? 'Balance after the deposit' : 'Balance on completion', doc.totalCents - deposit]);
  } else if (isInvoice && doc.paidCents) {
    totals.push(['Total', doc.totalCents]);
    totals.push([deposit > 0 ? 'Paid (incl. deposit)' : 'Paid', -doc.paidCents]);
  }
  const bigLabel = isInvoice
    ? depositDue
      ? 'Deposit due'
      : doc.paidCents >= doc.totalCents && doc.totalCents > 0
        ? 'Paid in full'
        : 'Amount due'
    : 'Quote total';
  const bigAmount = isInvoice ? (depositDue ? deposit - doc.paidCents : Math.max(balance, 0)) : doc.totalCents;
  const totalsH = totals.length * 16 + 44;
  const bankText = isInvoice && contact.bank ? `${contact.bank}\nReference: ${doc.number}` : '';
  pdf.font(regular).fontSize(9);
  const bankH = bankText ? pdf.heightOfString(bankText, { width: 230, lineGap: 1.5 }) + 34 : 0;
  ensure(Math.max(totalsH, bankH) + 10);
  const tx = R - 230;
  let ty = y;
  for (const [k, v] of totals) {
    pdf.font(regular).fontSize(9).fillColor(MUTED).text(k, tx, ty, { width: 150 });
    pdf.font(regular).fontSize(9.5).fillColor(INK).text(formatZar(v), tx + 120, ty, { width: 110, align: 'right' });
    ty += 16;
  }
  ty += 4;
  pdf.roundedRect(tx - 10, ty, 240, 34, 5).fill(accent);
  pdf.font(bold).fontSize(9).fillColor('#ffffff').text(bigLabel.toUpperCase(), tx, ty + 12, { width: 120, characterSpacing: 0.8 });
  pdf.font(bold).fontSize(14).fillColor('#ffffff').text(formatZar(bigAmount), tx + 90, ty + 9, { width: 130, align: 'right' });
  if (bankText) {
    pdf.roundedRect(L, y, 250, bankH, 5).lineWidth(1).strokeColor(tint(accent, 0.6)).stroke();
    label('Please pay into', L + 12, y + 10);
    pdf.font(regular).fontSize(9).fillColor(INK).text(bankText, L + 12, y + 23, { width: 230, lineGap: 1.5 });
  }
  y = Math.max(ty + 34, y + bankH) + 22;

  // ---- notes and terms
  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    pdf.font(regular).fontSize(8.5);
    const h = pdf.heightOfString(body, { width: contentW }) + 22;
    if (y + h > bottom()) {
      pdf.addPage();
      y = 50;
    }
    label(title, L, y);
    pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(body, L, y + 12, { width: contentW, lineGap: 1.5 });
    y = pdf.y + 14;
  };
  block('Notes', doc.notes);
  block(isInvoice ? 'Terms' : 'Terms and conditions', doc.terms);

  // ---- footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    pdf.page.margins.bottom = 0;
    const fy = pdf.page.height - 40;
    pdf.rect(0, pdf.page.height - 6, W, 6).fill(accent);
    const foot = [legal, settings.regNumber ? `Reg. ${settings.regNumber}` : '', settings.vatRegistered && settings.vatNumber ? `VAT ${settings.vatNumber}` : ''].filter(Boolean).join('  ·  ');
    pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(foot, L, fy, { width: contentW - 80, lineBreak: false });
    pdf.text(`Page ${i - range.start + 1} of ${range.count}`, R - 80, fy, { width: 80, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;
}
