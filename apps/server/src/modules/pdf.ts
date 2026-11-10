import PDFDocument from 'pdfkit';
import { featureOn, formatDate, formatZar, lineLabel, lineTotal, SALE_VAT, SHAP_LINE, SHAP_URL, type LineCategory, type SaleVatCode, regPrefix } from '@shap/shared';
import type { SettingsRow } from '../lib/books.js';
import { cleanImageCached } from '../lib/images.js';

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
  logoLayout?: LogoLayout;
}

/** Where the logo sits in its box at the top left: zoom 1 fits it; x and y move it by a share of the box. */
export interface LogoLayout {
  zoom?: number;
  x?: number;
  y?: number;
}
/** The logo's box in the heading, in points. The app's logo placer uses the same shape. */
export const LOGO_BOX = { w: 210, h: 78 } as const;

export interface PdfDocument {
  doc: {
    id: string;
    kind: 'quote' | 'invoice' | 'credit_note';
    proforma?: boolean;
    creditedInvoiceNumber?: string | null;
    /** Sold at the counter: an invoice issued and paid on the spot. */
    counter?: boolean;
    /** A sale from before 1.24 (its own kind then, on a slip): reprinted as it was handed over. */
    legacySale?: boolean;
    /** When a walk-in's details were added to their sale's invoice (the full tax invoice then). */
    invoicedAt?: string | Date | null;
    /** Before 1.24, the sale number an invoice made from a sale was first issued under; and a walk-in's name. */
    saleNumber?: string | null;
    customerName?: string | null;
    creditedInvoiceDate?: string | null;
    creditReason?: string;
    number: string;
    status: string;
    issueDate: string;
    dueDate: string | null;
    title: string;
    notes: string;
    terms: string;
    payLink?: string;
    vatRateBp: number;
    /** Prices typed including VAT. */
    pricesIncludeVat: boolean;
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
  lines: { id: string; category: LineCategory; description: string; qty: number; unit: string; unitPriceCents: number; lineTotalCents: number; vatCode: SaleVatCode }[];
  settings: SettingsRow;
  brand: BrandRow | null;
  logo: Buffer | null;
}

const INK = '#1d262c';
const MUTED = '#66737b';
const RULE = '#e2ddd5';
const ZEBRA = '#faf8f5';

// Atkinson Hyperlegible (the app's typeface), handed in by whoever starts the engine (the app
// bundles the font files; the tests read them from disk). Helvetica until then.
type FontData = ArrayBuffer | Uint8Array;
let REGULAR: FontData | null = null;
let BOLD: FontData | null = null;
export function setPdfFonts(fonts: { regular: FontData; bold: FontData } | null) {
  REGULAR = fonts?.regular ?? null;
  BOLD = fonts?.bold ?? null;
}

/** Registers the app's typeface on a PDF; returns the font names to use. */
export function usePdfFonts(pdf: PDFKit.PDFDocument): { regular: string; bold: string } {
  if (REGULAR) pdf.registerFont('Body', REGULAR as never);
  if (BOLD) pdf.registerFont('BodyBold', BOLD as never);
  return { regular: REGULAR ? 'Body' : 'Helvetica', bold: BOLD ? 'BodyBold' : 'Helvetica-Bold' };
}

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));


/** The Shap hand (the app icon's mark) in orange, `size` points square, top-left at x, y. */
export function drawShapMark(pdf: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const o = '#E8731C';
  pdf.save();
  pdf.translate(x, y).scale(size / 100);
  pdf.translate(50, 51).scale(0.74).rotate(-20).translate(-50, -56);
  pdf.lineCap('round');
  pdf.moveTo(41, 76).lineTo(41.5, 91).lineWidth(21).strokeColor(o).stroke();
  pdf.moveTo(37, 44).lineTo(23, 19).lineWidth(16).strokeColor(o).stroke();
  pdf.moveTo(60, 69).lineTo(86, 69).lineWidth(13).strokeColor(o).stroke();
  pdf.path('M29 47 C29 37 34 33 43 33 L59 33 C66 33 68 37 67 41 C72 42 73 46 72.5 49 C72 52 70 54 67 54.5 C71 55.5 72.5 58 72 61 C71.5 64 69 66 66 66 L66 69 C66 76 61 80 53 80 L41 80 C33 80 29 75 29 67 Z').fill(o);
  pdf.restore();
}

/** One quiet line at the foot of a page: the mark, the tagline and a link to Shap. */
export function shapFooter(pdf: PDFKit.PDFDocument, x: number, y: number, width: number, font: string) {
  drawShapMark(pdf, x, y - 1.5, 9);
  pdf.font(font).fontSize(6.5).fillColor('#8a959c');
  const link = 'openworks.co.za/shap';
  const lw = pdf.widthOfString(link);
  pdf.text(SHAP_LINE, x + 12, y, { width: width - lw - 20, lineBreak: false, ellipsis: true });
  pdf.fillColor('#c2611a').text(link, x + width - lw, y, { width: lw + 2, lineBreak: false, link: SHAP_URL });
}

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
  const { doc, lines, settings, brand } = data;
  // Only a logo known to decode reaches pdfkit (a damaged PNG would otherwise crash the server).
  const logo = data.logo ? cleanImageCached(data.logo) : null;
  const chosen = brand?.accent || settings.accent;
  const accent = chosen && /^#[0-9a-f]{6}$/i.test(chosen) ? chosen : '#e8731c';
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

  const pdf = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 60, left: 44, right: 44 }, bufferPages: true, info: { Title: `${doc.kind === 'invoice' ? 'Invoice' : doc.kind === 'credit_note' ? 'Credit note' : doc.proforma ? 'Pro-forma invoice' : 'Quote'} ${doc.number}`, Author: tradingName } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const regular = REGULAR ? 'Body' : 'Helvetica';
  const bold = BOLD ? 'BodyBold' : 'Helvetica-Bold';
  if (REGULAR) pdf.registerFont('Body', REGULAR as never);
  if (BOLD) pdf.registerFont('BodyBold', BOLD as never);

  const W = pdf.page.width;
  const L = 44;
  const R = W - 44;
  const contentW = R - L;
  const bottom = () => pdf.page.height - 74;
  const isCredit = doc.kind === 'credit_note';
  const isProforma = doc.kind === 'quote' && Boolean(doc.proforma);
  // A pro-forma asks to be paid like an invoice, but it isn't one (no tax invoice until the work's invoiced).
  const isInvoice = doc.kind === 'invoice';
  // A sale at the counter is an invoice paid on the spot (a walk-in's, the abridged tax invoice): it asks for nothing.
  const isSale = isInvoice && Boolean(doc.counter);
  const asksPayment = (isInvoice && !isSale) || isProforma;
  // Its own VAT rate says whether the business was a VAT vendor for it (not whether it is today):
  // a vendor's invoice is a tax invoice even when everything on it is zero-rated (VAT Act s20(4)(a)),
  // and one from before registering still reprints as a plain invoice.
  const vatShown = doc.vatRateBp > 0;
  const legacy = isInvoice && Boolean(doc.legacySale);
  const heading = isCredit ? 'Credit note' : legacy ? (vatShown ? 'Tax invoice' : 'Sale') : isInvoice ? (vatShown ? 'Tax invoice' : 'Invoice') : isProforma ? 'Pro-forma invoice' : 'Quotation';
  const balance = doc.totalCents - (isInvoice ? doc.paidCents : 0);
  const label = (text: string, x: number, at: number, opts: PDFKit.Mixins.TextOptions = {}) =>
    pdf.font(bold).fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), x, at, { characterSpacing: 0.9, ...opts });

  // ---- header: logo left, title and essentials right
  let y = 40;
  let logoBottom = y;
  if (logo) {
    try {
      const lay = brand?.logoLayout ?? settings.logoLayout ?? {};
      const img = (pdf as unknown as { openImage(src: unknown): { width: number; height: number } }).openImage(logo);
      const scale = Math.min(LOGO_BOX.w / img.width, LOGO_BOX.h / img.height) * (lay.zoom ?? 1);
      pdf.save();
      pdf.rect(L, y, LOGO_BOX.w, LOGO_BOX.h).clip();
      pdf.image(img as never, L + (lay.x ?? 0) * LOGO_BOX.w, y + (lay.y ?? 0) * LOGO_BOX.h, { width: img.width * scale, height: img.height * scale });
      pdf.restore();
      logoBottom = y + LOGO_BOX.h;
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
    [isCredit ? 'Credit note no.' : legacy ? 'Sale no.' : isInvoice ? 'Invoice no.' : isProforma ? 'Pro-forma no.' : 'Quote no.', doc.number],
    ['Date', formatDate(doc.issueDate)],
  ];
  // An invoice made from a sale before 1.24 says which sale it was first issued as.
  if (doc.saleNumber && doc.saleNumber !== doc.number) meta.push([legacy ? 'Issued as' : 'Sale no.', doc.saleNumber]);
  if (isCredit && doc.creditedInvoiceNumber) meta.push(['For invoice', doc.creditedInvoiceNumber]);
  if (isCredit && doc.creditedInvoiceDate) meta.push(['Invoice date', formatDate(doc.creditedInvoiceDate)]);
  // (A sale asks for nothing; one made an invoice before 1.24 had its due date, as it was issued.)
  if (doc.dueDate && !isCredit && !legacy && !(isSale && !doc.saleNumber)) meta.push([isInvoice || isProforma ? 'Due' : 'Valid until', formatDate(doc.dueDate)]);
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
  const replaces = fullAfterwards(doc);
  if (replaces) {
    pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(replaces, R - 260, my + 2, { width: 260, align: 'right' });
    my = pdf.y + 4;
  }
  y = Math.max(logoBottom, my) + 22;

  // ---- from / to band
  const colW = (contentW - 30) / 2;
  const bandTop = y;
  pdf.rect(L, bandTop, contentW, 2).fill(accent);
  y = bandTop + 14;
  label('From', L, y);
  // No client yet (a walk-in, or the name comes later): leave the "Bill to" side empty.
  const hasClient = Boolean(doc.clientName);
  if (hasClient) label(isInvoice || isProforma ? 'Bill to' : isCredit ? 'Credited to' : 'Prepared for', L + colW + 30, y);
  else if (doc.customerName) label('Sold to', L + colW + 30, y);
  y += 12;
  pdf.font(bold).fontSize(10.5).fillColor(INK).text(tradingName, L, y, { width: colW });
  const fromLines = [
    legal !== tradingName ? legal : '',
    settings.regNumber ? `${regPrefix(settings.businessType)} ${settings.regNumber}` : '',
    vatShown && settings.vatNumber ? `VAT no. ${settings.vatNumber}` : '',
    contact.address,
    [contact.phone, contact.email].filter(Boolean).join('  ·  '),
    contact.website,
  ].filter(Boolean);
  pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(fromLines.join('\n'), L, pdf.y + 2, { width: colW, lineGap: 1.2 });
  const fromBottom = pdf.y;
  if (hasClient) pdf.font(bold).fontSize(10.5).fillColor(INK).text(doc.clientName!, L + colW + 30, y, { width: colW });
  else if (doc.customerName) pdf.font(bold).fontSize(10.5).fillColor(INK).text(doc.customerName, L + colW + 30, y, { width: colW });
  else pdf.y = y;
  const toLines = [doc.clientContact && doc.clientContact !== doc.clientName ? doc.clientContact : '', doc.clientAddress, [doc.clientPhone, doc.clientEmail].filter(Boolean).join('  ·  '), doc.clientVatNumber ? `VAT no. ${doc.clientVatNumber}` : ''].filter(Boolean) as string[];
  pdf.font(regular).fontSize(8.5).fillColor(MUTED).text(toLines.join('\n'), L + colW + 30, pdf.y + 2, { width: colW, lineGap: 1.2 });
  y = Math.max(fromBottom, pdf.y) + 16;

  // ---- what it's for
  const forText = isCredit ? [doc.creditReason ? `Reason: ${doc.creditReason}` : '', doc.title || doc.projectName || ''].filter(Boolean).join('  ·  ') : doc.title || doc.projectName || '';
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
  // A VAT document has a VAT column (each line's kind of supply), and says whether its prices
  // include VAT or not.
  const incl = vatShown && doc.pricesIncludeVat;
  const priceWord = vatShown ? (incl ? 'INCL.' : 'EXCL.') : '';
  const cols = vatShown ? { desc: L + 10, qty: R - 300, unit: R - 236, vat: R - 150, amount: R - 92 } : { desc: L + 10, qty: R - 250, unit: R - 182, vat: 0, amount: R - 92 };
  const vatLabel = (c: SaleVatCode) => (c === 'standard' ? `${(doc.vatRateBp / 100).toFixed(doc.vatRateBp % 100 ? 1 : 0)}%` : SALE_VAT[c].short);
  const tableHeader = () => {
    pdf.font(bold).fontSize(8).fillColor(MUTED);
    pdf.text('DESCRIPTION', cols.desc, y, { characterSpacing: 0.6 });
    pdf.text('QTY', cols.qty, y, { width: 55, align: 'right', characterSpacing: 0.6 });
    pdf.text(vatShown ? `PRICE ${priceWord}` : 'UNIT PRICE', cols.unit, y, { width: 80, align: 'right', characterSpacing: 0.6 });
    if (vatShown) pdf.text('VAT', cols.vat, y, { width: 50, align: 'right', characterSpacing: 0.6 });
    pdf.text(vatShown ? `AMOUNT ${priceWord}` : 'AMOUNT', cols.amount, y, { width: 82, align: 'right', characterSpacing: 0.6 });
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
      pdf.font(bold).fontSize(8).fillColor(accent).text(lineLabel(settings.industry, cat).toUpperCase(), cols.desc, y + 4, { characterSpacing: 0.8 });
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
      if (vatShown) pdf.fillColor(MUTED).text(vatLabel(l.vatCode ?? 'standard'), cols.vat, y + 6, { width: 50, align: 'right' }).fillColor(INK);
      // As typed: including VAT on a VAT-inclusive document, else excluding it.
      pdf.font(bold).text(formatZar(incl ? lineTotal(Number(l.qty), Number(l.unitPriceCents)) : l.lineTotalCents), cols.amount, y + 6, { width: 82, align: 'right' });
      y += h;
    }
  }
  pdf.moveTo(L, y + 2).lineTo(R, y + 2).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 14;

  // ---- totals (right) and payment details (left), side by side
  const totals: [string, number][] = [];
  if (grouped) for (const cat of categories) totals.push([lineLabel(settings.industry, cat), lines.filter((l) => l.category === cat).reduce((s, l) => s + (incl ? lineTotal(Number(l.qty), Number(l.unitPriceCents)) : l.lineTotalCents), 0)]);
  // A tax invoice shows the value of the supply, the VAT and the total (s20(4)(g)); a credit note the reduction and its VAT (s21(3)).
  totals.push([vatShown ? 'Total excl. VAT' : 'Subtotal', doc.subtotalCents]);
  // What wasn't standard-rated, so the VAT can be checked (s20(4)(g)): zero-rated, exports, exempt.
  if (vatShown)
    for (const c of ['zero', 'export', 'exempt'] as const) {
      const v = lines.filter((l) => (l.vatCode ?? 'standard') === c).reduce((t, l) => t + Number(l.lineTotalCents), 0);
      if (v) totals.push([`  of which ${c === 'zero' ? 'zero-rated' : c === 'export' ? 'exported (0%)' : 'exempt'}`, v]);
    }
  if (vatShown) totals.push([`VAT ${(doc.vatRateBp / 100).toFixed(doc.vatRateBp % 100 ? 1 : 0)}%${incl ? ' (included)' : ''}`, doc.vatCents]);
  // A deposit is a request for part of the total up front. On an invoice it's what's due until it's in.
  const deposit = Math.min(doc.depositDueCents ?? 0, doc.totalCents);
  const depositLabel = `Deposit${doc.depositBp ? ` (${(doc.depositBp / 100).toFixed(doc.depositBp % 100 ? 1 : 0)}%)` : ''}`;
  const depositDue = isInvoice && deposit > 0 && doc.paidCents < deposit;
  // What credit notes settled isn't money paid: it's shown as credited.
  const credited = ((data as { receipts?: { method: string; amountCents: number }[] }).receipts ?? []).filter((r) => r.method === 'credit').reduce((t, r) => t + Number(r.amountCents), 0);
  const settled = (paidLabel: string) => {
    if (doc.paidCents - credited) totals.push([paidLabel, -(doc.paidCents - credited)]);
    if (credited) totals.push(['Credited (credit notes)', -credited]);
  };
  const totalLabel = vatShown ? 'Total incl. VAT' : 'Total';
  if (deposit > 0 && (!isInvoice || depositDue)) {
    totals.push([totalLabel, doc.totalCents]);
    totals.push([isInvoice ? `${depositLabel} due now` : `${depositLabel} to confirm`, deposit]);
    if (doc.paidCents) settled('Paid');
    if (!isInvoice || doc.depositShowBalance) totals.push([isInvoice ? 'Balance after the deposit' : 'Balance on completion', doc.totalCents - deposit]);
  } else if (isInvoice && doc.paidCents) {
    totals.push([totalLabel, doc.totalCents]);
    settled(deposit > 0 ? 'Paid (incl. deposit)' : 'Paid');
  } else if (vatShown) totals.push([totalLabel, doc.totalCents]);
  const bigLabel = isCredit
    ? 'Credited'
    : isInvoice
      ? depositDue
        ? 'Deposit due'
        : doc.paidCents >= doc.totalCents && doc.totalCents > 0
          ? 'Paid in full'
          : 'Amount due'
      : isProforma
        ? deposit > 0
          ? 'Deposit due'
          : 'Amount due'
        : 'Quote total';
  const bigAmount = isInvoice ? (depositDue ? deposit - doc.paidCents : Math.max(balance, 0)) : isProforma && deposit > 0 ? deposit : doc.totalCents;
  const totalsH = totals.length * 16 + 44;
  const bankText = asksPayment && contact.bank ? `${contact.bank}\nReference: ${doc.number}` : '';
  // A card payment link (Yoco, SnapScan…): this invoice's, or the business's usual one, while it's unpaid.
  const payLink = asksPayment && balance > 0 ? (doc.payLink || settings.payLink || '').trim() : '';
  // PayShap: an instant payment from the client's banking app to the business's ShapID.
  const payshap = asksPayment && balance > 0 && featureOn(settings.features, 'payshap') && settings.payshapId ? `${settings.payshapId}\nReference: ${doc.number}` : '';
  pdf.font(regular).fontSize(9);
  const linkH = payLink ? pdf.heightOfString(payLink, { width: 230 }) + 22 : 0;
  const shapH = payshap ? pdf.heightOfString(payshap, { width: 230, lineGap: 1.5 }) + 22 : 0;
  const bankH = bankText || payLink || payshap ? (bankText ? pdf.heightOfString(bankText, { width: 230, lineGap: 1.5 }) + 34 : 14) + linkH + shapH : 0;
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
  if (bankText || payLink || payshap) {
    pdf.roundedRect(L, y, 250, bankH, 5).lineWidth(1).strokeColor(tint(accent, 0.6)).stroke();
    let by = y + 10;
    if (bankText) {
      label('Please pay into', L + 12, by);
      pdf.font(regular).fontSize(9).fillColor(INK).text(bankText, L + 12, by + 13, { width: 230, lineGap: 1.5 });
      by = pdf.y + 10;
    }
    if (payshap) {
      label(bankText ? 'Or pay instantly with PayShap' : 'Pay instantly with PayShap', L + 12, by);
      pdf.font(bold).fontSize(9).fillColor(INK).text(payshap, L + 12, by + 13, { width: 230, lineGap: 1.5 });
      by = pdf.y + 10;
    }
    if (payLink) {
      label('Or pay by card', L + 12, by);
      pdf.font(bold).fontSize(9).fillColor(accent).text(payLink, L + 12, by + 13, { width: 230, link: payLink, underline: true });
    }
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
  if (isProforma) block('Please note', 'This is a pro-forma invoice, not a tax invoice. A tax invoice follows once the work is invoiced.');
  block(isInvoice || isProforma ? 'Terms' : isCredit ? 'Notes' : 'Terms and conditions', doc.terms);

  // ---- footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    pdf.page.margins.bottom = 0;
    const fy = pdf.page.height - (settings.watermark ? 46 : 40);
    pdf.rect(0, pdf.page.height - 6, W, 6).fill(accent);
    const foot = [legal, settings.regNumber ? `${regPrefix(settings.businessType)} ${settings.regNumber}` : '', vatShown && settings.vatNumber ? `VAT ${settings.vatNumber}` : ''].filter(Boolean).join('  ·  ');
    pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(foot, L, fy, { width: contentW - 80, lineBreak: false });
    pdf.text(`Page ${i - range.start + 1} of ${range.count}`, R - 80, fy, { width: 80, align: 'right', lineBreak: false });
    if (settings.watermark) shapFooter(pdf, L, fy + 14, contentW, regular);
  }
  pdf.end();
  return done;
}

/**
 * A walk-in's sale whose details were added afterwards: one tax invoice per supply (VAT Act s20(1)),
 * so the full one says it replaces the abridged one of the same number, and when that was issued.
 */
export function fullAfterwards(doc: Pick<PdfDocument['doc'], 'counter' | 'invoicedAt' | 'clientName' | 'issueDate' | 'saleNumber' | 'vatRateBp'>): string | null {
  if (!doc.counter || !doc.invoicedAt || !doc.clientName || doc.saleNumber) return null;
  const tax = Number(doc.vatRateBp) > 0;
  return `${tax ? 'Full tax invoice' : 'Invoice'} with the customer’s details, added ${formatDate(String(doc.invoicedAt instanceof Date ? doc.invoicedAt.toISOString() : doc.invoicedAt).slice(0, 10))}: it replaces the ${tax ? 'abridged tax invoice' : 'invoice'} of the same number issued on ${formatDate(doc.issueDate)}.`;
}
