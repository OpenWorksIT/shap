/**
 * The annual financial statements as a PDF: the set a compiler signs and the directors approve.
 * In the usual order of a South African set: the cover, contents, general information, the
 * directors' responsibilities and approval, the directors' report, the compiler's report, the four
 * statements, the accounting policies and notes, then the detailed income statement (which isn't
 * part of the financial statements). DRAFT on every page until it's compiled, FOR APPROVAL until
 * it's approved; once signed, who
 * signed and when, on the pages they sign.
 */
import PDFDocument from 'pdfkit';
import { formatAmount, formatDate } from '@shap/shared';
import { usePdfFonts } from '../modules/pdf.js';
import { lawFor } from './details.js';
import type { Amounts, Line, Statements } from './build.js';

const INK = '#1d262c';
const MUTED = '#66737b';
const RULE = '#cfc8bd';

export interface Signatures {
  compiler?: { name: string; qualification?: string; body?: string; number?: string; practice?: string; address?: string; date: string; how: 'in_shap' | 'uploaded' } | null;
  approved?: { name: string; date: string } | null;
}

const amt = (c: number | null | undefined) => (c == null ? '' : c === 0 ? '–' : formatAmount(c));

export function renderStatementsPdf(s: Statements, sig: Signatures = {}): Promise<Buffer> {
  const final = Boolean(sig.approved);
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 56, right: 56 }, bufferPages: true, info: { Title: `${s.company.name}: ${s.title} ${s.period}`, Author: s.company.name } });
  const { regular, bold } = usePdfFonts(pdf);
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const L = 56;
  const R = pdf.page.width - 56;
  const W = R - L;
  const yearOf = (iso: string) => iso.slice(0, 4);
  const cur = yearOf(s.fyEnd);
  const pri = yearOf(s.priorEnd);
  const contents: { title: string; page: number }[] = [];
  const many = s.governing.many;
  const Many = many.charAt(0).toUpperCase() + many.slice(1);
  // One owner, or several directors (partners, members…): the verbs and the possessive follow.
  const g = s.governing as { plural?: boolean; poss?: string };
  const pl = g.plural !== false;
  const Poss = (g.poss ?? `${many}’`).replace(/^./, (c) => c.toUpperCase());
  const v = (plural: string, single: string) => (pl ? plural : single);
  const companyish = ['company', 'inc', 'cc', 'npc', 'coop'].includes(s.company.businessType);
  // An incorporated business reports under the IFRS for SMEs Accounting Standard and its Act (the
  // Companies Act, the Close Corporations Act, the Co-operatives Act); anyone else on the basis
  // note 1 describes (its recognition and measurement principles).
  const law = lawFor(s.company.businessType);
  const framework = companyish ? `the IFRS for SMEs Accounting Standard and ${law?.short ?? 'the Companies Act'}` : 'the basis of accounting described in note 1';

  const heading = (title: string, sub?: string) => {
    contents.push({ title, page: pdf.bufferedPageRange().count });
    pdf.font(bold).fontSize(14).fillColor(INK).text(title, L, pdf.page.margins.top);
    if (sub) pdf.font(regular).fontSize(9.5).fillColor(MUTED).text(sub);
    pdf.moveDown(0.8);
  };
  const newPage = () => pdf.addPage();
  const para = (text: string, opts: { size?: number; gap?: number; font?: string } = {}) => {
    if (!text) return;
    pdf.font(opts.font ?? regular).fontSize(opts.size ?? 9.5).fillColor(INK).text(text, L, pdf.y, { width: W, align: 'justify', lineGap: 1.5 });
    pdf.moveDown(opts.gap ?? 0.6);
  };
  const ensure = (h: number) => {
    if (pdf.y + h > pdf.page.height - pdf.page.margins.bottom) newPage();
  };
  const colNote = R - 210;
  const colCur = R - 160;
  const colPri = R - 75;
  const colHead = (withNote = true) => {
    ensure(30);
    const y = pdf.y;
    pdf.font(bold).fontSize(8.5).fillColor(MUTED);
    if (withNote) pdf.text('Note', colNote, y, { width: 40, align: 'center' });
    pdf.text(`${cur}\nR`, colCur, y, { width: 75, align: 'right' });
    if (s.hasPrior) pdf.text(`${pri}\nR`, colPri, y, { width: 75, align: 'right' });
    pdf.y = y + 24;
  };
  const row = (label: string, a: Partial<Amounts> & { note?: number }, opts: { bold?: boolean; indent?: number; rule?: 'above' | 'double' } = {}) => {
    ensure(16);
    const y = pdf.y;
    if (opts.rule) {
      pdf.moveTo(colCur + 10, y - 2).lineTo(colCur + 75, y - 2).lineWidth(0.6).strokeColor(INK).stroke();
      if (s.hasPrior) pdf.moveTo(colPri + 10, y - 2).lineTo(colPri + 75, y - 2).stroke();
    }
    pdf.font(opts.bold ? bold : regular).fontSize(9.5).fillColor(INK).text(label, L + (opts.indent ?? 0), y, { width: colNote - L - (opts.indent ?? 0) - 6 });
    const h = pdf.y - y;
    if (a.note) pdf.font(regular).text(String(a.note), colNote, y, { width: 40, align: 'center' });
    pdf.font(opts.bold ? bold : regular).text(amt(a.current), colCur, y, { width: 75, align: 'right' });
    if (s.hasPrior) pdf.text(amt(a.prior), colPri, y, { width: 75, align: 'right' });
    pdf.y = y + Math.max(h, 13) + 2;
    if (opts.rule === 'double') {
      const yy = pdf.y - 3;
      for (const dy of [0, 2]) {
        pdf.moveTo(colCur + 10, yy + dy).lineTo(colCur + 75, yy + dy).lineWidth(0.5).strokeColor(INK).stroke();
        if (s.hasPrior) pdf.moveTo(colPri + 10, yy + dy).lineTo(colPri + 75, yy + dy).stroke();
      }
      pdf.y += 4;
    }
  };
  const lines = (ls: Line[], indent = 0) => ls.forEach((l) => row(l.label, l, { indent }));
  const sectionLabel = (t: string) => {
    ensure(20);
    pdf.moveDown(0.3);
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(t, L, pdf.y);
    pdf.moveDown(0.2);
  };

  // ---------------------------------------------------------------- cover
  pdf.font(bold).fontSize(22).fillColor(INK).text(s.company.name, L, 220, { width: W, align: 'center' });
  if (s.company.tradingName && s.company.tradingName !== s.company.name) pdf.font(regular).fontSize(11).fillColor(MUTED).text(`trading as ${s.company.tradingName}`, { width: W, align: 'center' });
  pdf.moveDown(0.6);
  if (s.company.regNumber) pdf.font(regular).fontSize(10).fillColor(MUTED).text(`Registration number ${s.company.regNumber}`, { width: W, align: 'center' });
  pdf.moveDown(2);
  pdf.font(bold).fontSize(16).fillColor(INK).text(s.title, { width: W, align: 'center' });
  pdf.font(regular).fontSize(12).fillColor(INK).text(s.period, { width: W, align: 'center' });
  pdf.moveDown(3);
  const assurance =
    s.details.assurance === 'compiled'
      ? `These financial statements were compiled by ${s.details.compiler.name || 'an independent accountant'}${s.details.compiler.qualification ? `, ${s.details.compiler.qualification}` : ''}. They have not been audited or independently reviewed.`
      : s.details.assurance === 'independent_review'
        ? 'These financial statements have been independently reviewed.'
        : s.details.assurance === 'audit'
          ? 'These financial statements have been audited.'
          : `These financial statements were prepared by the ${many}. They have not been audited or reviewed.`;
  pdf.font(regular).fontSize(9.5).fillColor(MUTED).text(assurance, L + 40, pdf.y, { width: W - 80, align: 'center' });
  if (s.details.preparedBy) pdf.text(`Prepared by ${s.details.preparedBy}.`, { width: W - 80, align: 'center' });
  pdf.moveDown(0.5);
  pdf.text(final ? `Issued ${formatDate(sig.approved!.date, 'long')}` : 'Draft: not yet approved', { width: W - 80, align: 'center' });

  // ---------------------------------------------------------------- contents (filled in at the end)
  newPage();
  const contentsPage = pdf.bufferedPageRange().count - 1;
  pdf.font(bold).fontSize(14).fillColor(INK).text('Contents', L, pdf.page.margins.top);

  // ---------------------------------------------------------------- general information
  newPage();
  heading('General information');
  const info: [string, string][] = [
    [companyish ? 'Country of incorporation and domicile' : 'Country of domicile', 'South Africa'],
    ['Nature of the business', s.directorsReport.find((r) => r.title === 'Nature of the business')?.text ?? ''],
    [Many, s.details.directors.map((d) => d.name).join('\n') || '(to be completed)'],
    ['Registered office', companyish ? s.details.registeredAddress || s.company.address : ''],
    ['Business address', s.company.address],
    ['Postal address', s.details.postalAddress],
    ['Bankers', s.details.bankers],
    ['Secretary', s.details.secretary],
    ['Holding company', s.details.holdingCompany],
    ['Registration number', s.company.regNumber],
    ['Income tax number', s.company.taxNumber],
    ['VAT number', s.company.vatNumber],
    ['Level of assurance', assurance],
    ['Compiled by', s.details.assurance === 'compiled' ? [s.details.compiler.name, s.details.compiler.qualification, s.details.compiler.practice].filter(Boolean).join(', ') : ''],
    ['Prepared by', s.details.preparedBy],
  ];
  for (const [k, v] of info) {
    if (!v) continue;
    ensure(20);
    const y = pdf.y;
    pdf.font(bold).fontSize(9.5).fillColor(INK).text(k, L, y, { width: 170 });
    const h1 = pdf.y - y;
    pdf.font(regular).text(v, L + 180, y, { width: W - 180 });
    pdf.y = Math.max(y + h1, pdf.y) + 6;
  }

  // ---------------------------------------------------------------- responsibilities and approval
  newPage();
  heading(`${Poss} responsibilities and approval`);
  para(
    `The ${many} ${v('are', 'is')} ${companyish ? `required by ${law?.full ?? 'the Companies Act 71 of 2008'} to maintain adequate accounting records and are ` : ''}responsible for the content and integrity of these financial statements. It is their responsibility to ensure that the financial statements ${companyish ? 'fairly present' : 'present'} the state of affairs of the business at the end of the financial year and the results of its operations and cash flows for the year, in conformity with ${framework}.`,
  );
  para(`The financial statements are prepared on the going concern basis, using appropriate accounting policies consistently applied and supported by reasonable and prudent judgements and estimates. The ${many} ${v('acknowledge', 'acknowledges')} that they are ultimately responsible for the system of internal control of the business, and that the accounting records were kept in Shap, which records every change in an audit log that can't be altered.`);
  para(
    s.details.assurance === 'compiled'
      ? `The financial statements were compiled by an independent accountant on the basis of the information the ${many} provided. A compilation is not an audit or a review: the ${many} ${v('remain', 'remains')} responsible for the information.`
      : '',
  );
  para(`The financial statements set out on the pages that follow, prepared on the going concern basis, were approved by the ${many} ${final ? `on ${formatDate(sig.approved!.date, 'long')}` : 'on ________________'} and are signed on their behalf by:`);
  pdf.moveDown(2);
  const signLine = (who: string, signedName?: string, date?: string) => {
    ensure(60);
    const y = pdf.y;
    pdf.moveTo(L, y).lineTo(L + 220, y).lineWidth(0.6).strokeColor(INK).stroke();
    pdf.font(regular).fontSize(9).fillColor(MUTED).text(who, L, y + 4);
    if (signedName) pdf.font(bold).fontSize(9.5).fillColor(INK).text(`${signedName}, approved in Shap on ${formatDate(date!, 'long')}`, L, y - 14, { width: 300 });
    pdf.y = y + 30;
  };
  if (final) signLine(s.governing.signs, sig.approved!.name, sig.approved!.date);
  else for (const d of s.details.directors.length ? s.details.directors : [{ name: '', role: s.governing.signs }]) signLine(`${d.name || s.governing.signs}${d.role ? ` (${d.role})` : ''}`);

  // ---------------------------------------------------------------- directors' report
  newPage();
  heading(`${Poss} report`, `The ${many} ${v('present', 'presents')} their report ${s.period}.`);
  s.directorsReport.forEach((r, i) => {
    ensure(40);
    pdf.font(bold).fontSize(10).fillColor(INK).text(`${i + 1}. ${r.title}`, L, pdf.y);
    pdf.moveDown(0.2);
    para(r.text);
  });

  // ---------------------------------------------------------------- compiler's report
  if (s.details.assurance === 'compiled') {
    newPage();
    // To those who own it: a company's shareholders, a CC's or co-op's members; an NPC's directors.
    const to = ({ company: 'shareholders', inc: 'shareholders', npc: 'directors', cc: 'members', coop: 'members' } as Partial<Record<string, string>>)[s.company.businessType] ?? many;
    heading('Independent compiler’s report', `To the ${to} of ${s.company.name}`);
    const c = sig.compiler ?? null;
    const comp = c ?? { ...s.details.compiler, date: '' };
    para(
      `We have compiled the accompanying financial statements of ${s.company.name} based on information you have provided. These financial statements comprise the statement of financial position as at ${formatDate(s.fyEnd, 'long')}, and the statement of comprehensive income, the statement of changes in equity and the statement of cash flows for the year then ended, and the notes, including the material accounting policy information.`,
    );
    para('We performed this compilation engagement in accordance with the International Standard on Related Services 4410 (Revised), Compilation Engagements.');
    para(
      `We have applied our expertise in accounting and financial reporting to assist you in the preparation and presentation of these financial statements in accordance with ${companyish ? `the IFRS for SMEs Accounting Standard and the requirements of ${law?.full ?? 'the Companies Act 71 of 2008'}` : 'the basis of accounting described in note 1'}. We have complied with relevant ethical requirements, including principles of integrity, objectivity, professional competence and due care.`,
    );
    para('These financial statements and the accuracy and completeness of the information used to compile them are your responsibility.');
    para(
      `Since a compilation engagement is not an assurance engagement, we are not required to verify the accuracy or completeness of the information you provided to us to compile these financial statements. Accordingly, we do not express an audit opinion or a review conclusion on whether these financial statements are prepared in accordance with ${companyish ? 'the IFRS for SMEs Accounting Standard' : 'the basis of accounting described in note 1'}.`,
    );
    pdf.moveDown(1.5);
    if (c?.how === 'uploaded') para(`Signed by ${c.name} on ${formatDate(c.date, 'long')}: the signed report is kept with these statements in Shap.`, { font: bold });
    else if (c) para(`Signed in Shap by ${c.name} on ${formatDate(c.date, 'long')}.`, { font: bold });
    else {
      pdf.moveTo(L, pdf.y + 20).lineTo(L + 220, pdf.y + 20).lineWidth(0.6).strokeColor(INK).stroke();
      pdf.y += 26;
    }
    para([comp.name, [comp.qualification, comp.body && comp.number ? `${comp.body} ${comp.number}` : comp.body].filter(Boolean).join(', '), comp.practice, comp.address, comp.date ? formatDate(comp.date, 'long') : 'Date: ________________'].filter(Boolean).join('\n'), { size: 9.5 });
  }

  // ---------------------------------------------------------------- statement of financial position
  newPage();
  heading('Statement of financial position', `as at ${formatDate(s.fyEnd, 'long')}`);
  colHead();
  sectionLabel('Assets');
  for (const b of s.sfp.assets) {
    sectionLabel(b.label);
    lines(b.lines, 10);
    row(`Total ${b.label.toLowerCase()}`, b, { bold: true, rule: 'above' });
  }
  row('Total assets', s.sfp.totalAssets, { bold: true, rule: 'double' });
  pdf.moveDown(0.6);
  sectionLabel('Equity and liabilities');
  sectionLabel(s.sfp.equity.label);
  lines(s.sfp.equity.lines, 10);
  row('Total equity', s.sfp.equity, { bold: true, rule: 'above' });
  for (const b of s.sfp.liabilities) {
    sectionLabel(b.label);
    lines(b.lines, 10);
    row(`Total ${b.label.toLowerCase()}`, b, { bold: true, rule: 'above' });
  }
  row('Total liabilities', s.sfp.totalLiabilities, { bold: true });
  row('Total equity and liabilities', s.sfp.totalEquityAndLiabilities, { bold: true, rule: 'double' });

  // ---------------------------------------------------------------- statement of comprehensive income
  newPage();
  heading('Statement of comprehensive income', s.period);
  colHead();
  lines(s.sci.revenue);
  lines(s.sci.costOfSales);
  row('Gross profit', s.sci.grossProfit, { bold: true, rule: 'above' });
  lines(s.sci.otherIncome);
  lines(s.sci.operatingExpenses);
  row('Operating profit (loss)', s.sci.operatingProfit, { bold: true, rule: 'above' });
  lines(s.sci.financeIncome);
  lines(s.sci.financeCosts);
  row('Profit (loss) before taxation', s.sci.profitBeforeTax, { bold: true, rule: 'above' });
  row('Income tax expense', { ...s.sci.incomeTax, note: s.notes.find((n) => n.key === 'tax')?.number });
  row('Profit (loss) for the year', s.sci.profit, { bold: true, rule: 'above' });
  row('Other comprehensive income', { current: 0, prior: 0 });
  row('Total comprehensive income for the year', s.sci.profit, { bold: true, rule: 'double' });

  // ---------------------------------------------------------------- statement of changes in equity
  newPage();
  heading('Statement of changes in equity', s.period);
  {
    const cols = [...s.soce.columns.map((c) => c.label), 'Total equity'];
    const first = L + 170;
    const cw = (R - first) / cols.length;
    const y0 = pdf.y;
    pdf.font(bold).fontSize(8.5).fillColor(MUTED);
    cols.forEach((c, i) => pdf.text(`${c}\nR`, first + i * cw, y0, { width: cw - 4, align: 'right' }));
    pdf.y = y0 + 34;
    for (const r of s.soce.rows) {
      ensure(18);
      const y = pdf.y;
      pdf.font(r.bold ? bold : regular).fontSize(9).fillColor(INK).text(r.label, L, y, { width: 165 });
      const h = pdf.y - y;
      [...r.values, r.total].forEach((v, i) => pdf.text(amt(v), first + i * cw, y, { width: cw - 4, align: 'right' }));
      pdf.y = y + Math.max(h, 12) + (r.bold ? 8 : 3);
    }
  }

  // ---------------------------------------------------------------- statement of cash flows
  newPage();
  heading('Statement of cash flows', s.period);
  colHead(false);
  sectionLabel('Cash flows from operating activities');
  lines(s.scf.operating, 10);
  row('Net cash from operating activities', s.scf.netOperating, { bold: true, rule: 'above' });
  sectionLabel('Cash flows from investing activities');
  lines(s.scf.investing, 10);
  row('Net cash from investing activities', s.scf.netInvesting, { bold: true, rule: 'above' });
  sectionLabel('Cash flows from financing activities');
  lines(s.scf.financing, 10);
  row('Net cash from financing activities', s.scf.netFinancing, { bold: true, rule: 'above' });
  pdf.moveDown(0.4);
  row('Total cash movement for the year', s.scf.netChange, { bold: true });
  row('Cash and cash equivalents at the beginning of the year', s.scf.opening);
  row('Cash and cash equivalents at the end of the year', { ...s.scf.closing, note: s.notes.find((n) => n.key === 'cash')?.number }, { bold: true, rule: 'double' });

  // ---------------------------------------------------------------- notes
  newPage();
  heading('Notes to the financial statements', s.period);
  for (const n of s.notes) {
    ensure(50);
    pdf.font(bold).fontSize(10.5).fillColor(INK).text(`${n.number}. ${n.title}`, L, pdf.y);
    pdf.moveDown(0.3);
    for (const p of n.paragraphs) para(p);
    for (const t of n.tables) {
      if (t.head) {
        ensure(26);
        const y = pdf.y;
        pdf.font(bold).fontSize(8.5).fillColor(MUTED).text(t.head[0] ?? '', L, y, { width: colNote - L });
        if (t.head.length === 3 && t.head[1] === 'R') pdf.text('R', colCur, y, { width: 75, align: 'right' });
        else {
          pdf.text(`${cur}\nR`, colCur, y, { width: 75, align: 'right' });
          if (s.hasPrior) pdf.text(`${pri}\nR`, colPri, y, { width: 75, align: 'right' });
        }
        pdf.y = y + 24;
      } else colHead(false);
      for (const r of t.rows) row(r.label, { current: r.current ?? undefined, prior: r.prior ?? undefined }, { bold: r.bold, rule: r.bold && r.label === 'Total' ? 'above' : undefined, indent: 10 });
      pdf.moveDown(0.5);
    }
    pdf.moveDown(0.4);
  }

  // ---------------------------------------------------------------- detailed income statement
  newPage();
  heading('Detailed income statement', `${s.period}. This statement doesn’t form part of the financial statements.`);
  colHead(false);
  for (const g of s.detailed) {
    sectionLabel(g.label);
    for (const l of g.lines) row(l.name, l, { indent: 10 });
    row(`Total ${g.label.toLowerCase()}`, g.total, { bold: true, rule: 'above' });
  }
  row('Profit (loss) for the year', s.sci.profit, { bold: true, rule: 'double' });

  // ---------------------------------------------------------------- contents, headers and footers
  const range = pdf.bufferedPageRange();
  pdf.switchToPage(contentsPage);
  pdf.y = pdf.page.margins.top + 34;
  for (const c of contents) {
    const y = pdf.y;
    pdf.font(regular).fontSize(10.5).fillColor(INK).text(c.title, L, y, { width: W - 60 });
    pdf.text(String(c.page), R - 50, y, { width: 50, align: 'right' });
    pdf.y = y + 20;
  }
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(i);
    const bottom = pdf.page.height - 40;
    pdf.page.margins.bottom = 0;
    if (i > 0) {
      pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(`${s.company.name}  ·  ${s.title} ${s.period}`, L, 30, { width: W, lineBreak: false });
      pdf.moveTo(L, 44).lineTo(R, 44).lineWidth(0.4).strokeColor(RULE).stroke();
      pdf.font(regular).fontSize(7.5).fillColor(MUTED).text(`Page ${i + 1}`, R - 60, bottom, { width: 60, align: 'right', lineBreak: false });
      pdf.text('The notes form part of these financial statements. Prepared in Shap.', L, bottom, { width: W - 70, lineBreak: false });
    }
    if (!final) {
      pdf.save();
      pdf.rotate(-35, { origin: [pdf.page.width / 2, pdf.page.height / 2] });
      pdf.font(bold).fontSize(sig.compiler ? 60 : 80).fillColor('#b42318').opacity(0.07).text(sig.compiler ? 'FOR APPROVAL' : 'DRAFT', 0, pdf.page.height / 2 - 50, { width: pdf.page.width, align: 'center', lineBreak: false });
      pdf.restore();
      pdf.opacity(1);
    }
  }
  pdf.end();
  return done;
}
