/**
 * Imports a project tracker workbook (the Excel layout Shap grew out of):
 *   Per Project   one row per job: client code, invoice no. and date, quoted / invoiced split
 *                 into labour, parts and demo, amount received, demo cost
 *   Costs         every purchase: date, name, cost, supplier, type, account, project, personal
 *   Wages List    every worker-day: date, worker, wage, allowance, total, paid, project, casual name, personal
 *   Trade Statement   monthly pivot, used only to check the import
 *   Trial Balance …   a year-end trial balance, used to agree that year's bank and loan balances
 *
 * Columns are found by their headings, so moved or extra columns don't matter.
 */
import ExcelJS from 'exceljs';

export interface TrackerPlan {
  clients: { code: string }[];
  projects: PlannedProject[];
  costs: PlannedCost[];
  workers: { name: string; kind: 'permanent' | 'casual'; dayRateCents: number; allowanceCents: number; lastDate: string }[];
  labour: { date: string; worker: string; projectKey: string | null; wageCents: number; allowanceCents: number }[];
  wagePayments: { date: string; worker: string; amountCents: number; personal: boolean; note: string }[];
  savings: { date: string; worker: string; amountCents: number; note: string }[];
  trialBalance: { date: string; bankCents: number; ownerLoanCents: number; shareCapitalCents: number; profitCents: number | null } | null;
  tradeStatement: { month: string; invoicedCents: number; partsCents: number; labourCents: number }[];
  accounts: string[];
  types: string[];
  /** Mark-up read from a "To Charge" formula such as =L93*1.35, in basis points. */
  markupBp: number | null;
  warnings: string[];
  skipped: { costsWithoutAmount: number; labourPlaceholders: number; savingsRows: number };
}

export interface PlannedProject {
  key: string;
  number: number | null;
  name: string;
  clientCode: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  estLabourCents: number;
  estMaterialsCents: number;
  estDemoCents: number;
  invoicedLabourCents: number;
  invoicedMaterialsCents: number;
  invoicedDemoCents: number;
  invoicedTotalCents: number;
  receivedCents: number;
  demoCostCents: number;
  /** The sheet's own "C Labour" / "C Parts" figures, to check the import against. */
  sheetLabourCents: number | null;
  sheetPartsCents: number | null;
  fromSheet: boolean;
}

export interface PlannedCost {
  date: string;
  description: string;
  amountCents: number;
  supplier: string;
  type: string;
  account: string;
  projectKey: string | null;
  personal: 'owner_paid' | 'personal_expense' | null;
  note: string;
}

type Cell = ExcelJS.CellValue;

export const projectKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function value(v: Cell): string | number | Date | null {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string' || v instanceof Date) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    if ('result' in v) return value((v as { result: Cell }).result);
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: string }).text);
    if ('error' in v) return null;
  }
  return null;
}
const num = (v: Cell): number | null => {
  const x = value(v);
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(x)) return Number(x);
  return null;
};
const str = (v: Cell): string => {
  const x = value(v);
  if (x == null) return '';
  if (x instanceof Date) return isoOf(x);
  return String(x).trim();
};
const cents = (n: number | null) => (n == null ? 0 : Math.round(n * 100));
function isoOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const date = (v: Cell): string | null => {
  const x = value(v);
  if (x instanceof Date) return isoOf(x);
  if (typeof x === 'number' && x > 20000 && x < 80000) return isoOf(new Date(Date.UTC(1899, 11, 30) + x * 86400000));
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10);
  return null;
};

/** Finds a header row (within the first rows) containing all the given headings; returns heading → column. */
function headerMap(ws: ExcelJS.Worksheet, required: string[], maxRow = 8): { row: number; col: Map<string, number> } | null {
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount); r++) {
    const col = new Map<string, number>();
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const h = str(cell.value).toLowerCase();
      if (h && !col.has(h)) col.set(h, c);
    });
    if (required.every((h) => col.has(h.toLowerCase()))) return { row: r, col };
  }
  return null;
}

function sheet(wb: ExcelJS.Workbook, ...names: string[]): ExcelJS.Worksheet | undefined {
  const want = names.map((n) => n.toLowerCase());
  return wb.worksheets.find((w) => want.includes(w.name.trim().toLowerCase()));
}

export async function readTracker(buffer: Buffer | ArrayBuffer): Promise<TrackerPlan> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  const warnings: string[] = [];
  const plan: TrackerPlan = {
    clients: [],
    projects: [],
    costs: [],
    workers: [],
    labour: [],
    wagePayments: [],
    savings: [],
    trialBalance: null,
    tradeStatement: [],
    accounts: [],
    types: [],
    markupBp: null,
    warnings,
    skipped: { costsWithoutAmount: 0, labourPlaceholders: 0, savingsRows: 0 },
  };
  const projects = new Map<string, PlannedProject>();
  const extraProject = (name: string): string => {
    const key = projectKey(name);
    if (!projects.has(key)) {
      projects.set(key, {
        key, number: null, name: name.trim(), clientCode: null, invoiceNumber: null, invoiceDate: null,
        estLabourCents: 0, estMaterialsCents: 0, estDemoCents: 0, invoicedLabourCents: 0, invoicedMaterialsCents: 0,
        invoicedDemoCents: 0, invoicedTotalCents: 0, receivedCents: 0, demoCostCents: 0, sheetLabourCents: null, sheetPartsCents: null, fromSheet: false,
      });
    }
    return key;
  };

  // ---------------------------------------------------------------- Per Project
  const pp = sheet(wb, 'Per Project');
  if (!pp) throw new Error('This workbook has no "Per Project" sheet');
  const ph = headerMap(pp, ['Project', 'Client', 'Invoice #', 'Date']);
  if (!ph) throw new Error('Couldn’t find the headings on the Per Project sheet (Project, Client, Invoice #, Date)');
  const pc = (h: string) => ph.col.get(h.toLowerCase());
  const clientCodes = new Set<string>();
  const chargeCol = pc('To Charge');
  for (let r = ph.row + 1; chargeCol && plan.markupBp == null && r <= pp.rowCount; r++) {
    const v = pp.getRow(r).getCell(chargeCol).value;
    const f = v && typeof v === 'object' && 'formula' in v ? String((v as { formula: string }).formula) : '';
    const m = f.match(/\*\s*(\d+(?:\.\d+)?)\s*$/);
    if (m && Number(m[1]) > 1 && Number(m[1]) < 3) plan.markupBp = Math.round((Number(m[1]) - 1) * 10000);
  }
  for (let r = ph.row + 1; r <= pp.rowCount; r++) {
    const row = pp.getRow(r);
    const get = (h: string) => {
      const c = pc(h);
      return c ? row.getCell(c).value : null;
    };
    const name = str(get('Project'));
    if (!name) continue;
    const key = projectKey(name);
    if (projects.has(key)) {
      warnings.push(`"${name}" is listed twice on Per Project; the second row (row ${r}) was skipped`);
      continue;
    }
    const clientCode = str(get('Client')) || null;
    if (clientCode) clientCodes.add(clientCode);
    const invNum = num(get('Invoice #'));
    const invoicedLabour = cents(num(get('I Labour')));
    const invoicedParts = cents(num(get('I Parts')));
    const invoicedDemo = cents(num(get('I Demo')));
    const invoicedTotal = num(get('I Total')) != null ? cents(num(get('I Total'))) : invoicedLabour + invoicedParts + invoicedDemo;
    projects.set(key, {
      key,
      number: num(get('#')) != null ? Math.round(num(get('#'))!) : null,
      name,
      clientCode,
      invoiceNumber: invNum != null ? String(invNum) : str(get('Invoice #')) || null,
      invoiceDate: date(get('Date')),
      estLabourCents: cents(num(get('Q Labour'))),
      estMaterialsCents: cents(num(get('Q Parts'))),
      estDemoCents: cents(num(get('Q Demo'))),
      invoicedLabourCents: invoicedLabour,
      invoicedMaterialsCents: invoicedParts,
      invoicedDemoCents: invoicedDemo,
      invoicedTotalCents: invoicedTotal,
      receivedCents: cents(num(get('Received'))),
      demoCostCents: cents(num(get('C Demo'))),
      sheetLabourCents: pc('C Labour') ? cents(num(get('C Labour'))) : null,
      sheetPartsCents: pc('C Parts') ? cents(num(get('C Parts'))) : null,
      fromSheet: true,
    });
  }

  // ---------------------------------------------------------------- Costs
  const cs = sheet(wb, 'Costs');
  if (cs) {
    const h = headerMap(cs, ['Date', 'Cost', 'Type']);
    if (!h) warnings.push('Couldn’t find the headings on the Costs sheet; no costs were read');
    else {
      const c = (k: string) => h.col.get(k.toLowerCase());
      const accounts = new Set<string>();
      const types = new Set<string>();
      for (let r = h.row + 1; r <= cs.rowCount; r++) {
        const row = cs.getRow(r);
        const get = (k: string) => (c(k) ? row.getCell(c(k)!).value : null);
        const d = date(get('Date'));
        const amount = num(get('Cost'));
        const description = str(get('Name'));
        if (!d && amount == null && !description) continue;
        if (amount == null || amount === 0) {
          plan.skipped.costsWithoutAmount++;
          continue;
        }
        if (!d) {
          warnings.push(`Costs row ${r} (${description || 'no name'}) has no date and was skipped`);
          continue;
        }
        const personalRaw = str(get('Personal'));
        const projectName = str(get('Project'));
        const account = str(get('Account'));
        const type = str(get('Type'));
        accounts.add(account);
        types.add(type);
        let personal: PlannedCost['personal'] = null;
        let projectKeyValue: string | null = null;
        let note = '';
        if (personalRaw && personalRaw.toUpperCase() !== 'Y') {
          // A personal job (e.g. "Home roof"): the owner's own expense, not a company job.
          personal = 'personal_expense';
          note = personalRaw;
        } else {
          if (personalRaw.toUpperCase() === 'Y') personal = 'owner_paid';
          if (projectName) projectKeyValue = projects.has(projectKey(projectName)) ? projectKey(projectName) : extraProject(projectName);
        }
        plan.costs.push({
          date: d,
          description: description || type || 'Cost',
          amountCents: cents(amount),
          supplier: str(get('Supplier')),
          type,
          account,
          projectKey: projectKeyValue,
          personal,
          note,
        });
      }
      plan.accounts = [...accounts].sort();
      plan.types = [...types].sort();
    }
  } else warnings.push('No "Costs" sheet found');

  // ---------------------------------------------------------------- Wages List
  const wl = sheet(wb, 'Wages List', 'Wages');
  if (wl) {
    const h = headerMap(wl, ['Date', 'Worker', 'Wage']);
    if (!h) warnings.push('Couldn’t find the headings on the Wages List sheet; no labour was read');
    else {
      const c = (k: string) => h.col.get(k.toLowerCase());
      const casualCol = c('Casual?') ?? c('Casual');
      const workers = new Map<string, TrackerPlan['workers'][number]>();
      const rateHistory = new Map<string, { date: string; wage: number; allowance: number }[]>();
      for (let r = h.row + 1; r <= wl.rowCount; r++) {
        const row = wl.getRow(r);
        const get = (k: string) => (c(k) ? row.getCell(c(k)!).value : null);
        const d = date(get('Date'));
        let worker = str(get('Worker'));
        if (!d) continue;
        const wage = num(get('Wage'));
        const allowance = num(get('Allowance'));
        const totalCell = num(get('Total'));
        const paid = num(get('Paid'));
        const project = str(get('Project'));
        const casualValue = casualCol ? row.getCell(casualCol).value : null;
        const personal = str(get('Personal')).toUpperCase() === 'Y';
        if (!worker) {
          if ((totalCell ?? 0) !== 0 || (paid ?? 0) !== 0) warnings.push(`Wages row ${r} has amounts but no worker and was skipped`);
          else plan.skipped.labourPlaceholders++;
          continue;
        }
        let kind: 'permanent' | 'casual' = 'permanent';
        if (worker.toLowerCase() === 'casual') {
          kind = 'casual';
          const named = typeof value(casualValue) === 'string' ? str(casualValue) : '';
          worker = named ? named : 'Casual (unnamed)';
        }
        const isSavings = /^(to|from) savings$/i.test(project);
        if (isSavings) {
          plan.skipped.savingsRows++;
          // The amount sits in the Casual? column, as a number or as text like "( R400 Handed to me)".
          let amt = num(casualValue);
          let note = project;
          if (amt == null) {
            const text = str(casualValue);
            const m = text.match(/-?\s*R?\s*(\d+(?:[.,]\d{1,2})?)/i);
            if (m) {
              amt = Number(m[1]!.replace(',', '.')) * (/from savings/i.test(project) ? -1 : 1);
              note = `${project} ${text.replace(/[()]/g, '').trim()}`;
            }
          }
          if (amt != null && amt !== 0) plan.savings.push({ date: d, worker, amountCents: cents(amt), note });
          // Money handed over for savings counts as paid; a matching earned-and-paid pair nets to nothing.
          if (paid && !(totalCell && totalCell === paid)) plan.wagePayments.push({ date: d, worker, amountCents: cents(paid), personal, note: 'Into savings' });
          continue;
        }
        const total = totalCell ?? (wage ?? 0) + (allowance ?? 0);
        const allow = allowance ?? 0;
        const wageValue = total - allow;
        if (total !== 0) {
          let pk: string | null = null;
          if (project) pk = projects.has(projectKey(project)) ? projectKey(project) : extraProject(project);
          plan.labour.push({ date: d, worker, projectKey: pk, wageCents: cents(wageValue), allowanceCents: cents(allow) });
          const w = workers.get(worker) ?? { name: worker, kind, dayRateCents: 0, allowanceCents: 0, lastDate: d };
          if (d >= w.lastDate) w.lastDate = d;
          workers.set(worker, w);
          const hist = rateHistory.get(worker) ?? [];
          hist.push({ date: d, wage: cents(wage ?? wageValue), allowance: cents(allow) });
          rateHistory.set(worker, hist);
        } else if (!workers.has(worker)) {
          workers.set(worker, { name: worker, kind, dayRateCents: 0, allowanceCents: 0, lastDate: d });
        }
        if (paid != null && paid !== 0) plan.wagePayments.push({ date: d, worker, amountCents: cents(paid), personal, note: '' });
      }
      // A worker's rate is what they were usually paid lately, not whatever the last row says
      // (that is sometimes a one-off allowance or a lump sum for a contract).
      const usual = (xs: number[]) => {
        const counts = new Map<number, number>();
        for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
      };
      for (const w of workers.values()) {
        const recent = (rateHistory.get(w.name) ?? []).sort((a, b) => a.date.localeCompare(b.date)).slice(-15);
        w.dayRateCents = usual(recent.map((r) => r.wage));
        w.allowanceCents = usual(recent.map((r) => r.allowance));
      }
      plan.workers = [...workers.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
  } else warnings.push('No "Wages List" sheet found');

  // ---------------------------------------------------------------- Trade Statement (for checking)
  const ts = sheet(wb, 'Trade Statement');
  if (ts) {
    let yearRow = 0;
    for (let r = 1; r <= Math.min(12, ts.rowCount); r++) {
      const cells: string[] = [];
      ts.getRow(r).eachCell((cell) => cells.push(str(cell.value)));
      if (cells.some((x) => /^20\d\d$/.test(x))) {
        yearRow = r;
        break;
      }
    }
    if (yearRow) {
      const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const colMonth = new Map<number, string>();
      let year = '';
      for (let c = 2; c <= ts.columnCount; c++) {
        const y = str(ts.getRow(yearRow).getCell(c).value);
        if (/^20\d\d$/.test(y)) year = y;
        const m = monthNames.indexOf(str(ts.getRow(yearRow + 1).getCell(c).value).toLowerCase().slice(0, 3));
        if (year && m >= 0) colMonth.set(c, `${year}-${String(m + 1).padStart(2, '0')}`);
      }
      const rowOf = (label: string) => {
        for (let r = yearRow + 2; r <= Math.min(yearRow + 12, ts.rowCount); r++) if (str(ts.getRow(r).getCell(1).value).toLowerCase() === label) return r;
        return 0;
      };
      const ri = rowOf('invoiced');
      const rp = rowOf('parts cost');
      const rl = rowOf('labour cost');
      for (const [c, m] of colMonth) {
        plan.tradeStatement.push({
          month: m,
          invoicedCents: ri ? cents(num(ts.getRow(ri).getCell(c).value)) : 0,
          partsCents: rp ? cents(num(ts.getRow(rp).getCell(c).value)) : 0,
          labourCents: rl ? cents(num(ts.getRow(rl).getCell(c).value)) : 0,
        });
      }
    }
  }

  // ---------------------------------------------------------------- Trial balance (a closed year to agree to)
  const tbSheet = wb.worksheets.find((w) => /^trial balance/i.test(w.name.trim()));
  if (tbSheet) {
    let tbDate: string | null = null;
    let bank = 0;
    let loan = 0;
    let share = 0;
    let profit: number | null = null;
    for (let r = 1; r <= Math.min(80, tbSheet.rowCount); r++) {
      const row = tbSheet.getRow(r);
      const label = str(row.getCell(2).value);
      const lower = label.toLowerCase();
      const dr = num(row.getCell(3).value) ?? 0;
      const cr = num(row.getCell(4).value) ?? 0;
      const m = label.match(/as (?:of|at) (\w+) (\d{1,2}),? (\d{4})/i);
      if (m) {
        const mi = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(m[1]!.toLowerCase());
        if (mi >= 0) tbDate = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
      }
      if (/bank/.test(lower) && /account|fnb|first national/.test(lower) && !/charges/.test(lower)) bank += cents(dr - cr);
      else if (/^loan/.test(lower) || /director|shareholder|owner/.test(lower)) loan += cents(cr - dr);
      else if (/share capital/.test(lower)) share += cents(cr - dr);
      // The summary line "Net Profit / (Loss)" carries the year's profit as a positive figure.
      else if (/^net(t)? profit/.test(lower) && /\(loss\)/.test(lower) && (cr || dr)) profit = cents(dr || -cr);
    }
    if (tbDate) plan.trialBalance = { date: tbDate, bankCents: bank, ownerLoanCents: loan, shareCapitalCents: share, profitCents: profit };
    else warnings.push(`Found "${tbSheet.name}" but couldn’t read its date ("As of …"); year-end balances weren’t agreed`);
  }

  plan.clients = [...clientCodes].sort().map((code) => ({ code }));
  plan.projects = [...projects.values()];
  const extra = plan.projects.filter((p) => !p.fromSheet);
  if (extra.length) warnings.push(`${extra.length} job${extra.length === 1 ? '' : 's'} appear in Costs or Wages but not on Per Project, and were added: ${extra.map((p) => p.name).join(', ')}`);
  return plan;
}
