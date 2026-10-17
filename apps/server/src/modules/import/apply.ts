import { addDays, formatDate } from '@shap/shared';
import type { Sql, Tx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { projectSummarySql } from '../projects.js';
import type { TrackerPlan } from './tracker.js';

export interface ImportOptions {
  /** Wipe existing jobs, people, costs and documents first (settings, users and lists are kept). */
  replace?: boolean;
  /** Post one journal so bank, loan and share capital agree with the tracker's trial balance. */
  agreeTrialBalance?: boolean;
  userId?: string | null;
}

export interface MonthCheck {
  month: string;
  sheet: { invoicedCents: number; partsCents: number; labourCents: number };
  shap: { invoicedCents: number; partsCents: number; labourCents: number };
}

export interface JobCheck {
  name: string;
  field: 'labour' | 'parts';
  sheetCents: number;
  shapCents: number;
}

export interface ImportResult {
  counts: Record<string, number>;
  jobsChecked: number;
  jobDifferences: JobCheck[];
  warnings: string[];
  checks: MonthCheck[];
  agreement: { date: string; lines: { account: string; amountCents: number }[]; note: string } | null;
  sourceMapping: { account: string; source: string; postsTo: string }[];
}

const OPERATIONAL_TABLES = [
  'receipts', 'document_lines', 'documents', 'planned_items', 'assets', 'costs', 'labour_entries',
  'wage_payments', 'worker_savings', 'balance_checks', 'projects', 'workers',
] as const;

const chunk = <T>(xs: T[], n = 500): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function isCompanyEmpty(db: Sql | Tx): Promise<boolean> {
  const [r] = await db<{ n: number }[]>`
    select (select count(*) from projects) + (select count(*) from costs) + (select count(*) from labour_entries)
         + (select count(*) from documents) + (select count(*) from workers) as n`;
  return r!.n === 0;
}

export async function applyTracker(sql: Sql, plan: TrackerPlan, opts: ImportOptions = {}): Promise<ImportResult> {
  const warnings = [...plan.warnings];
  const counts: Record<string, number> = {};
  return sql.begin(async (tx) => {
    if (!(await isCompanyEmpty(tx))) {
      if (!opts.replace) throw badRequest('Shap already has jobs or costs in it. Tick “Replace what’s there” to import over them.');
      for (const t of OPERATIONAL_TABLES) await tx`delete from ${tx(t)}`;
      await tx`delete from journals where kind = 'import'`;
    }

    // ---------------------------------------------------------- where money came from
    const accountId = async (key: string) => (await tx<{ id: string }[]>`select id from accounts where system_key = ${key}`)[0]!.id;
    const bankAcc = await accountId('bank');
    const loanAcc = await accountId('owner_loan');
    const suspenseAcc = await accountId('suspense');
    const shareAcc = await accountId('share_capital');
    const ensureSource = async (name: string, kind: string, account: string): Promise<string> => {
      const [found] = await tx<{ id: string }[]>`select id from payment_sources where lower(name) = lower(${name})`;
      if (found) return found.id;
      const [row] = await tx<{ id: string }[]>`
        insert into payment_sources (name, kind, account_id, sort) values (${name}, ${kind}, ${account}, (select coalesce(max(sort), 0) + 1 from payment_sources)) returning id`;
      return row!.id;
    };
    const businessBank = await ensureSource('Business bank', 'bank', bankAcc);
    const cash = await ensureSource('Cash', 'cash', loanAcc);
    const ownerPaid = await ensureSource('Paid personally (owner)', 'owner', loanAcc);
    // A blank "Account" means it wasn't captured yet: no source, so it waits in "Not captured yet".
    const sourceFor = new Map<string, string | null>();
    const mapping: ImportResult['sourceMapping'] = [];
    for (const acc of plan.accounts) {
      let id: string | null;
      let postsTo: string;
      if (!acc) {
        id = null;
        postsTo = 'Not captured yet (assign under Costs)';
      } else if (/\bcs\b|business|company/i.test(acc)) {
        // "FNB CS" / "CS FNB": the company's own account.
        id = businessBank;
        postsTo = 'Bank';
      } else {
        // Cards and accounts in the owner's name: the company owes the owner for these.
        id = await ensureSource(acc, /cc|card|miles|credit/i.test(acc) ? 'card' : 'owner', loanAcc);
        postsTo = 'Owner’s loan';
      }
      sourceFor.set(acc, id);
      mapping.push({ account: acc || '(blank)', source: acc ? (id === businessBank ? 'Business bank' : acc) : 'Not captured yet', postsTo });
    }

    // ---------------------------------------------------------- what costs were for
    const categories = await tx<{ id: string; name: string; kind: string }[]>`select id, name, kind from cost_categories`;
    const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
    const aliases: Record<string, string> = { 'cellphone c': 'cellphone', 'vehicle maintenance': 'vehicle maintenance', parts: 'parts', '': 'sundry' };
    const sundryAcc = await accountId('sundry');
    const categoryFor = async (type: string): Promise<string> => {
      const key = aliases[type.trim().toLowerCase()] ?? type.trim().toLowerCase();
      const hit = byName.get(key);
      if (hit) return hit;
      const [row] = await tx<{ id: string }[]>`
        insert into cost_categories (name, kind, account_id, sort) values (${type.trim()}, 'overhead', ${sundryAcc}, (select coalesce(max(sort), 0) + 1 from cost_categories)) returning id`;
      byName.set(key, row!.id);
      warnings.push(`New cost type "${type.trim()}" was added as a running cost (Sundry). Change where it posts under Settings → Lists.`);
      return row!.id;
    };
    const personalCat = byName.get('personal (owner)')!;
    const demoCat = byName.get('demo')!;

    // ---------------------------------------------------------- clients
    const clientIds = new Map<string, string>();
    for (const c of plan.clients) {
      // A client already set up (e.g. from a company file or an earlier import) is reused by its code.
      const [found] = await tx<{ id: string }[]>`select id from clients where lower(code) = lower(${c.code})`;
      const id = found?.id ?? (await tx<{ id: string }[]>`insert into clients (code, name) values (${c.code}, ${c.code}) returning id`)[0]!.id;
      clientIds.set(c.code, id);
    }
    counts.clients = plan.clients.length;

    // ---------------------------------------------------------- jobs
    const firstActivity = new Map<string, string>();
    const touch = (key: string | null, d: string) => {
      if (!key) return;
      const cur = firstActivity.get(key);
      if (!cur || d < cur) firstActivity.set(key, d);
    };
    plan.costs.forEach((c) => touch(c.projectKey, c.date));
    plan.labour.forEach((l) => touch(l.projectKey, l.date));
    const used = new Set(plan.projects.map((p) => p.number).filter((n): n is number => n != null));
    let nextNumber = Math.max(0, ...used) + 1;
    const seenNumbers = new Set<number>();
    const projectIds = new Map<string, string>();
    for (const p of plan.projects) {
      let number = p.number;
      if (number == null || seenNumbers.has(number)) number = nextNumber++;
      seenNumbers.add(number);
      const status = p.invoiceNumber ? (p.receivedCents >= p.invoicedTotalCents && p.invoicedTotalCents > 0 ? 'done' : 'invoiced') : 'active';
      const start = firstActivity.get(p.key) ?? p.invoiceDate;
      const [row] = await tx<{ id: string }[]>`
        insert into projects (number, name, client_id, status, start_date, end_date, est_labour_cents, est_materials_cents, est_demo_cents, notes)
        values (${number}, ${p.name}, ${p.clientCode ? clientIds.get(p.clientCode)! : null}, ${status}, ${start}, ${p.invoiceDate},
                ${p.estLabourCents}, ${p.estMaterialsCents}, ${p.estDemoCents}, ${p.fromSheet ? '' : 'Added from Costs or Wages (not on Per Project).'})
        returning id`;
      projectIds.set(p.key, row!.id);
    }
    counts.projects = plan.projects.length;

    // ---------------------------------------------------------- workers, labour, wages, savings
    const workerIds = new Map<string, string>();
    // Anyone who hasn't worked in the last 90 days of the tracker is kept, but off the crew list.
    const lastDay = plan.labour.reduce((m, l) => (l.date > m ? l.date : m), '');
    const activeFrom = lastDay ? addDays(lastDay, -90) : '';
    for (const w of plan.workers) {
      const [row] = await tx<{ id: string }[]>`
        insert into workers (name, kind, day_rate_cents, allowance_cents, active)
        values (${w.name}, ${w.kind}, ${w.dayRateCents}, ${w.allowanceCents}, ${w.lastDate >= activeFrom}) returning id`;
      workerIds.set(w.name, row!.id);
    }
    const workerId = async (name: string) => {
      let id = workerIds.get(name);
      if (!id) {
        const [row] = await tx<{ id: string }[]>`insert into workers (name, kind) values (${name}, 'casual') returning id`;
        id = row!.id;
        workerIds.set(name, id);
      }
      return id;
    };
    const labourRows = [];
    for (const l of plan.labour) {
      labourRows.push({
        date: l.date, workerId: await workerId(l.worker), projectId: l.projectKey ? projectIds.get(l.projectKey)! : null,
        days: 1, wageCents: l.wageCents, allowanceCents: l.allowanceCents, createdBy: opts.userId ?? null,
      });
    }
    for (const part of chunk(labourRows)) await tx`insert into labour_entries ${tx(part)}`;
    counts.labour = labourRows.length;
    counts.unallocatedLabour = labourRows.filter((r) => !r.projectId).length;

    const payRows = [];
    for (const p of plan.wagePayments) {
      payRows.push({ date: p.date, workerId: await workerId(p.worker), amountCents: p.amountCents, sourceId: p.personal ? ownerPaid : cash, note: p.note, createdBy: opts.userId ?? null });
    }
    for (const part of chunk(payRows)) await tx`insert into wage_payments ${tx(part)}`;
    counts.wagePayments = payRows.length;
    counts.workers = workerIds.size;

    for (const s of plan.savings) {
      await tx`insert into worker_savings (date, worker_id, amount_cents, note) values (${s.date}, ${await workerId(s.worker)}, ${s.amountCents}, ${s.note})`;
    }
    counts.savings = plan.savings.length;

    // ---------------------------------------------------------- costs
    const costRows = [];
    for (const c of plan.costs) {
      const category = c.personal === 'personal_expense' ? personalCat : await categoryFor(c.type);
      const source = !c.account && c.personal === 'owner_paid' ? ownerPaid : (sourceFor.get(c.account) ?? null);
      costRows.push({
        date: c.date, description: c.description, amountCents: c.amountCents, vatCents: 0, supplier: c.supplier,
        categoryId: category, sourceId: source, projectId: c.projectKey ? projectIds.get(c.projectKey)! : null,
        note: c.personal === 'personal_expense' ? `Personal: ${c.note}` : c.personal === 'owner_paid' ? 'Paid personally' : '', createdBy: opts.userId ?? null,
      });
    }
    // Demo / removal costs were typed straight onto Per Project; they become costs on the job.
    for (const p of plan.projects) {
      if (!p.demoCostCents) continue;
      costRows.push({
        date: p.invoiceDate ?? firstActivity.get(p.key) ?? new Date().toISOString().slice(0, 10), description: 'Demo & removal (from tracker)',
        amountCents: p.demoCostCents, vatCents: 0, supplier: '', categoryId: demoCat, sourceId: null,
        projectId: projectIds.get(p.key)!, note: 'From the C Demo column on Per Project', createdBy: opts.userId ?? null,
      });
    }
    for (const part of chunk(costRows)) await tx`insert into costs ${tx(part)}`;
    counts.costs = costRows.length;
    counts.uncapturedCosts = costRows.filter((r) => r.sourceId == null).length;

    // ---------------------------------------------------------- invoices and payments received
    const [settings] = await tx<{ paymentDays: number; defaultReceiptSourceId: string | null }[]>`select payment_days, default_receipt_source_id from settings where id`;
    const receiptSource = settings!.defaultReceiptSourceId ?? businessBank;
    const numbers = new Set<string>();
    let maxInvoice = 0;
    let invoices = 0;
    for (const p of plan.projects) {
      if (!p.invoiceNumber || !p.invoiceDate) {
        if (p.invoiceNumber && !p.invoiceDate) warnings.push(`Invoice ${p.invoiceNumber} (${p.name}) has no date and wasn’t created`);
        continue;
      }
      let number = p.invoiceNumber;
      if (numbers.has(number)) {
        let i = 2;
        while (numbers.has(`${p.invoiceNumber}-${i}`)) i++;
        number = `${p.invoiceNumber}-${i}`;
        warnings.push(`Invoice number ${p.invoiceNumber} is used twice in the tracker; ${p.name} was imported as ${number}`);
      }
      numbers.add(number);
      const whole = Math.floor(Number(p.invoiceNumber));
      if (Number.isFinite(whole)) maxInvoice = Math.max(maxInvoice, whole);
      const lines: { category: string; description: string; amount: number }[] = [];
      if (p.invoicedLabourCents) lines.push({ category: 'labour', description: `Labour – ${p.name}`, amount: p.invoicedLabourCents });
      if (p.invoicedMaterialsCents) lines.push({ category: 'materials', description: `Materials – ${p.name}`, amount: p.invoicedMaterialsCents });
      if (p.invoicedDemoCents) lines.push({ category: 'demo', description: `Demo & removal – ${p.name}`, amount: p.invoicedDemoCents });
      const split = lines.reduce((s, l) => s + l.amount, 0);
      if (p.invoicedTotalCents !== split) lines.push({ category: 'other', description: `${p.name}${split ? ' (balance)' : ''}`, amount: p.invoicedTotalCents - split });
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      const [doc] = await tx<{ id: string }[]>`
        insert into documents (kind, number, status, project_id, client_id, issue_date, due_date, title, notes, vat_rate_bp, subtotal_cents, vat_cents, total_cents, created_by)
        values ('invoice', ${number}, 'issued', ${projectIds.get(p.key)!}, ${p.clientCode ? clientIds.get(p.clientCode)! : null}, ${p.invoiceDate},
                ${addDays(p.invoiceDate, settings!.paymentDays)}, ${p.name}, 'Imported from the project tracker.', 0, ${subtotal}, 0, ${subtotal}, ${opts.userId ?? null})
        returning id`;
      let sort = 0;
      for (const l of lines) {
        await tx`insert into document_lines (document_id, sort, category, description, qty, unit, unit_price_cents, line_total_cents)
                 values (${doc!.id}, ${sort++}, ${l.category}, ${l.description}, 1, '', ${l.amount}, ${l.amount})`;
      }
      if (p.receivedCents) {
        await tx`insert into receipts (invoice_id, date, amount_cents, source_id, method, note, created_by)
                 values (${doc!.id}, ${p.invoiceDate}, ${p.receivedCents}, ${receiptSource}, 'eft', 'Imported: the tracker records the amount, not the day it arrived', ${opts.userId ?? null})`;
      }
      invoices++;
    }
    counts.invoices = invoices;
    if (maxInvoice) await tx`update settings set invoice_next = greatest(invoice_next, ${maxInvoice + 1}) where id`;
    if (plan.markupBp != null) await tx`update settings set markup_bp = ${plan.markupBp} where id`;

    // ---------------------------------------------------------- agree a closed year to its trial balance
    let agreement: ImportResult['agreement'] = null;
    const [agreed] = plan.trialBalance ? await tx`select 1 from year_ends where fy_end = ${plan.trialBalance.date}` : [];
    if (agreed) warnings.push(`The year to ${formatDate(plan.trialBalance!.date)} is already agreed to your accountant’s figures, so the tracker’s trial balance was skipped.`);
    if (opts.agreeTrialBalance !== false && plan.trialBalance && !agreed) {
      const tb = plan.trialBalance;
      const bal = async (acc: string) =>
        (await tx<{ b: number }[]>`select coalesce(sum(amount_cents), 0)::bigint as b from ledger where account_id = ${acc} and date <= ${tb.date}::date`)[0]!.b;
      const adjust = [
        { account: 'Bank', id: bankAcc, amount: tb.bankCents - (await bal(bankAcc)) },
        { account: 'Owner’s loan', id: loanAcc, amount: -tb.ownerLoanCents - (await bal(loanAcc)) },
        { account: 'Share capital', id: shareAcc, amount: -tb.shareCapitalCents - (await bal(shareAcc)) },
      ].filter((a) => a.amount !== 0);
      const plug = -adjust.reduce((s, a) => s + a.amount, 0);
      if (plug !== 0) adjust.push({ account: 'Suspense (to sort out)', id: suspenseAcc, amount: plug });
      if (adjust.length) {
        const [j] = await tx<{ id: string }[]>`
          insert into journals (date, description, reference, kind, created_by)
          values (${tb.date}, ${`Agree balances to the trial balance at ${formatDate(tb.date)}`}, 'Tracker import', 'import', ${opts.userId ?? null}) returning id`;
        for (const a of adjust) {
          await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo)
                   values (${j!.id}, ${a.id}, ${a.amount > 0 ? a.amount : 0}, ${a.amount < 0 ? -a.amount : 0}, ${a.account === 'Suspense (to sort out)' ? 'Difference between the tracker detail and the trial balance' : ''})`;
        }
        agreement = {
          date: tb.date,
          lines: adjust.map((a) => ({ account: a.account, amountCents: a.amount })),
          note:
            'Loan repayments and money moved between the bank and your cards were never captured line by line, so one journal brings bank, loan and share capital to the trial balance figures.' +
            (plug ? ' What’s left over sits in Suspense for you or your accountant to look at.' : ''),
        };
      }
    }

    // ---------------------------------------------------------- check against the Trade Statement
    // Shap's own books, month by month: revenue, cost of sales – materials, cost of sales – labour.
    const shapMonths = await tx<{ month: string; invoiced: number; parts: number; labour: number }[]>`
      select to_char(l.date, 'YYYY-MM') as month,
        coalesce(-sum(l.amount_cents) filter (where a.system_key like 'revenue\_%'), 0)::bigint as invoiced,
        coalesce(sum(l.amount_cents) filter (where a.system_key = 'cos_materials'), 0)::bigint as parts,
        coalesce(sum(l.amount_cents) filter (where a.system_key = 'cos_labour'), 0)::bigint as labour
      from ledger l join accounts a on a.id = l.account_id
      where a.system_key like 'revenue\_%' or a.system_key in ('cos_materials', 'cos_labour')
      group by 1 order by 1`;
    const checks: MonthCheck[] = plan.tradeStatement.map((t) => {
      const s = shapMonths.find((x) => x.month === t.month);
      return {
        month: t.month,
        sheet: { invoicedCents: t.invoicedCents, partsCents: t.partsCents, labourCents: t.labourCents },
        shap: { invoicedCents: s?.invoiced ?? 0, partsCents: s?.parts ?? 0, labourCents: s?.labour ?? 0 },
      };
    });

    // ---------------------------------------------------------- check each job against Per Project
    const summaries = await tx.unsafe(`select s.id, s.actual_labour_cents, s.actual_materials_cents from (${projectSummarySql}) s`);
    const byId = new Map(summaries.map((r) => [r.id as string, r as unknown as { actualLabourCents: number; actualMaterialsCents: number }]));
    const jobDifferences: JobCheck[] = [];
    let jobsChecked = 0;
    for (const p of plan.projects) {
      if (!p.fromSheet) continue;
      const s = byId.get(projectIds.get(p.key)!);
      if (!s) continue;
      jobsChecked++;
      // Excel keeps fractions of a cent; Shap stores whole cents, so allow a rand of rounding per job.
      if (p.sheetLabourCents != null && Math.abs(p.sheetLabourCents - s.actualLabourCents) > 100)
        jobDifferences.push({ name: p.name, field: 'labour', sheetCents: p.sheetLabourCents, shapCents: s.actualLabourCents });
      if (p.sheetPartsCents != null && Math.abs(p.sheetPartsCents - s.actualMaterialsCents) > 100)
        jobDifferences.push({ name: p.name, field: 'parts', sheetCents: p.sheetPartsCents, shapCents: s.actualMaterialsCents });
    }

    await audit(tx, { userId: opts.userId ?? null, actor: 'import', action: 'import_tracker', entity: 'company', details: { counts, replace: Boolean(opts.replace) } });
    return { counts, jobsChecked, jobDifferences, warnings, checks, agreement, sourceMapping: mapping };
  });
}
