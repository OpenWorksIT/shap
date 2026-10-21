import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ACCOUNT_TYPE_LABELS,
  assetInput,
  balanceCheckInput,
  financialYear,
  journalInput,
  monthLabel,
  monthsBetween,
  type AccountType,
} from '@shap/shared';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { assertOpen, centsToCsv, getSettings, isIsoDate, q, toCsv, today } from '../lib/books.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.string().uuid() });
const PL: AccountType[] = ['income', 'cost_of_sales', 'expense'];

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  active: boolean;
}

export async function accountBalances(db: Db, opts: { from?: string | null; to: string }) {
  return db<(AccountRow & { balanceCents: number; postings: number })[]>`
    select a.id, a.code, a.name, a.type, a.system_key, a.active,
      coalesce(sum(l.amount_cents), 0)::bigint as balance_cents, count(l.account_id)::int as postings
    from accounts a
    left join ledger l on l.account_id = a.id and l.date <= ${opts.to}::date and (${opts.from ?? null}::date is null or l.date >= ${opts.from ?? null}::date)
    group by a.id order by a.code`;
}

/** Trial balance at a date: balance-sheet accounts to date, P&L accounts for the financial year to date. */
export async function trialBalance(db: Db, date: string) {
  const settings = await getSettings(db);
  const fy = financialYear(date, settings.fyEndMonth);
  const [all, pl, prior] = await Promise.all([
    accountBalances(db, { to: date }),
    accountBalances(db, { from: fy.start, to: date }),
    db<{ total: number }[]>`
      select coalesce(sum(l.amount_cents), 0)::bigint as total from ledger l join accounts a on a.id = l.account_id
      where a.type in ('income', 'cost_of_sales', 'expense') and l.date < ${fy.start}::date`,
  ]);
  const plMap = new Map(pl.map((a) => [a.id, a]));
  const priorProfit = prior[0]!.total; // debit-positive: a profit is negative
  const rows = all.map((a) => {
    let bal = PL.includes(a.type) ? (plMap.get(a.id)?.balanceCents ?? 0) : a.balanceCents;
    if (a.systemKey === 'retained_earnings') bal += priorProfit;
    return { id: a.id, code: a.code, name: a.name, type: a.type, debitCents: bal > 0 ? bal : 0, creditCents: bal < 0 ? -bal : 0, balanceCents: bal };
  });
  const shown = rows.filter((r) => r.balanceCents !== 0);
  const debit = shown.reduce((s, r) => s + r.debitCents, 0);
  const credit = shown.reduce((s, r) => s + r.creditCents, 0);
  return { date, financialYear: fy, rows: shown, totals: { debitCents: debit, creditCents: credit, differenceCents: debit - credit } };
}

/** Income statement for a period, optionally with a column per month (the tracker's Trade Statement). */
export async function incomeStatement(db: Db, from: string, to: string, byMonth: boolean) {
  const months = byMonth ? monthsBetween(from, to) : [];
  const rows = await db<{ accountId: string; month: string; total: number }[]>`
    select l.account_id, to_char(l.date, 'YYYY-MM') as month, sum(l.amount_cents)::bigint as total
    from ledger l join accounts a on a.id = l.account_id
    where a.type in ('income', 'cost_of_sales', 'expense') and l.date between ${from}::date and ${to}::date
    group by 1, 2`;
  const accounts = await db<AccountRow[]>`select * from accounts where type in ('income', 'cost_of_sales', 'expense') order by code`;
  const byAccount = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, new Map());
    byAccount.get(r.accountId)!.set(r.month, r.total);
  }
  // Show income as positive and costs as positive, as on a statement.
  const line = (a: AccountRow) => {
    const m = byAccount.get(a.id) ?? new Map<string, number>();
    const sign = a.type === 'income' ? -1 : 1;
    const total = [...m.values()].reduce((s, v) => s + v, 0) * sign;
    return { id: a.id, code: a.code, name: a.name, type: a.type, systemKey: a.systemKey, totalCents: total, months: months.map((mo) => (m.get(mo) ?? 0) * sign) };
  };
  const all = accounts.map(line).filter((l) => l.totalCents !== 0 || l.months.some((v) => v !== 0));
  const isTax = (l: { systemKey: string | null }) => l.systemKey === 'income_tax';
  const income = all.filter((l) => l.type === 'income');
  const cos = all.filter((l) => l.type === 'cost_of_sales');
  const expenses = all.filter((l) => l.type === 'expense' && !isTax(l));
  const tax = all.filter(isTax);
  const sum = (ls: typeof all) => ({
    totalCents: ls.reduce((s, l) => s + l.totalCents, 0),
    months: months.map((_, i) => ls.reduce((s, l) => s + (l.months[i] ?? 0), 0)),
  });
  const minus = (a: ReturnType<typeof sum>, b: ReturnType<typeof sum>) => ({ totalCents: a.totalCents - b.totalCents, months: a.months.map((v, i) => v - (b.months[i] ?? 0)) });
  const tIncome = sum(income);
  const tCos = sum(cos);
  const gross = minus(tIncome, tCos);
  const tExp = sum(expenses);
  const beforeTax = minus(gross, tExp);
  const tTax = sum(tax);
  const net = minus(beforeTax, tTax);
  return {
    from,
    to,
    months: months.map((m) => ({ key: m, label: monthLabel(m) })),
    income,
    costOfSales: cos,
    expenses,
    tax,
    totals: { income: tIncome, costOfSales: tCos, grossProfit: gross, expenses: tExp, profitBeforeTax: beforeTax, tax: tTax, netProfit: net },
  };
}

/** Balance sheet at a date. Retained earnings carry prior years' profit; this year's shows on its own line. */
export async function balanceSheet(db: Db, date: string) {
  const tb = await trialBalance(db, date);
  const settings = await getSettings(db);
  const fy = financialYear(date, settings.fyEndMonth);
  const accounts = await db<AccountRow[]>`select * from accounts`;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const plRows = tb.rows.filter((r) => PL.includes(r.type));
  const currentProfit = -plRows.reduce((s, r) => s + r.balanceCents, 0);
  const item = (r: (typeof tb.rows)[number], sign: 1 | -1) => ({ id: r.id, code: r.code, name: r.name, amountCents: r.balanceCents * sign });
  const assets = tb.rows.filter((r) => r.type === 'asset');
  // Non-current: property, plant & equipment (1500–1549, 1590), then intangible assets (1550–1599).
  const isIntangible = (code: string) => code >= '1550' && code < '1600' && code !== '1590';
  const nonCurrent = assets.filter((r) => r.code >= '1500' && r.code < '1600' && !isIntangible(r.code)).map((r) => item(r, 1));
  const intangible = assets.filter((r) => isIntangible(r.code)).map((r) => item(r, 1));
  const current = assets.filter((r) => !(r.code >= '1500' && r.code < '1600')).map((r) => item(r, 1));
  const liabilities = tb.rows.filter((r) => r.type === 'liability');
  const longTerm = liabilities.filter((r) => byId.get(r.id)?.systemKey === 'owner_loan').map((r) => item(r, -1));
  const shortTerm = liabilities.filter((r) => byId.get(r.id)?.systemKey !== 'owner_loan').map((r) => item(r, -1));
  const equity = tb.rows.filter((r) => r.type === 'equity').map((r) => item(r, -1));
  if (currentProfit !== 0) equity.push({ id: 'current-profit', code: '', name: `Profit for the year to date (${fy.label})`, amountCents: currentProfit });
  const total = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);
  const totalAssets = total(nonCurrent) + total(intangible) + total(current);
  const totalLiabilities = total(longTerm) + total(shortTerm);
  const totalEquity = total(equity);
  return {
    date,
    financialYear: fy,
    assets: { nonCurrent, intangible, current, totalCents: totalAssets },
    liabilities: { nonCurrent: longTerm, current: shortTerm, totalCents: totalLiabilities },
    equity: { items: equity, totalCents: totalEquity },
    differenceCents: totalAssets - totalLiabilities - totalEquity,
  };
}

function sendCsv(reply: FastifyReply, filename: string, csv: string) {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${filename}"`);
  return reply.send(csv);
}

export function registerReportRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const readers = { preHandler: requireRole('owner', 'accountant') };
  const owner = { preHandler: requireRole('owner') };

  app.get('/api/reports/trial-balance', readers, async (req, reply) => {
    const { date, format } = q(req);
    const tb = await trialBalance(sql, isIsoDate(date) ? date : today());
    if (format === 'csv') {
      return sendCsv(reply, `trial-balance-${tb.date}.csv`, toCsv(['Code', 'Account', 'Type', 'Debit', 'Credit'], [
        ...tb.rows.map((r) => [r.code, r.name, ACCOUNT_TYPE_LABELS[r.type], r.debitCents ? centsToCsv(r.debitCents) : '', r.creditCents ? centsToCsv(r.creditCents) : '']),
        ['', 'Total', '', centsToCsv(tb.totals.debitCents), centsToCsv(tb.totals.creditCents)],
      ]));
    }
    return tb;
  });

  app.get('/api/reports/income-statement', readers, async (req, reply) => {
    const settings = await getSettings(sql);
    const { from, to, by, format } = q(req);
    const fy = financialYear(today(), settings.fyEndMonth);
    const f = isIsoDate(from) ? from : fy.start;
    const t = isIsoDate(to) ? to : today();
    if (f > t) throw badRequest('The start date is after the end date');
    const is = await incomeStatement(sql, f, t, by === 'month');
    if (format === 'csv') {
      const head = ['Code', 'Account', ...is.months.map((m) => m.label), 'Total'];
      const row = (code: string, name: string, x: { totalCents: number; months: number[] }) => [code, name, ...x.months.map(centsToCsv), centsToCsv(x.totalCents)];
      const rows = [
        ...is.income.map((l) => row(l.code, l.name, l)),
        row('', 'Total income', is.totals.income),
        ...is.costOfSales.map((l) => row(l.code, l.name, l)),
        row('', 'Gross profit', is.totals.grossProfit),
        ...is.expenses.map((l) => row(l.code, l.name, l)),
        row('', 'Total expenses', is.totals.expenses),
        row('', 'Profit before tax', is.totals.profitBeforeTax),
        ...is.tax.map((l) => row(l.code, l.name, l)),
        row('', 'Net profit', is.totals.netProfit),
      ];
      return sendCsv(reply, `income-statement-${f}-to-${t}.csv`, toCsv(head, rows));
    }
    return is;
  });

  app.get('/api/reports/balance-sheet', readers, async (req, reply) => {
    const { date, format } = q(req);
    const bs = await balanceSheet(sql, isIsoDate(date) ? date : today());
    if (format === 'csv') {
      const r = (x: { code: string; name: string; amountCents: number }) => [x.code, x.name, centsToCsv(x.amountCents)];
      return sendCsv(reply, `balance-sheet-${bs.date}.csv`, toCsv(['Code', 'Item', 'Amount'], [
        ['', 'Non-current assets', ''], ...bs.assets.nonCurrent.map(r),
        ...(bs.assets.intangible.length ? [['', 'Intangible assets', ''], ...bs.assets.intangible.map(r)] : []),
        ['', 'Current assets', ''], ...bs.assets.current.map(r),
        ['', 'Total assets', centsToCsv(bs.assets.totalCents)],
        ['', 'Non-current liabilities', ''], ...bs.liabilities.nonCurrent.map(r),
        ['', 'Current liabilities', ''], ...bs.liabilities.current.map(r),
        ['', 'Total liabilities', centsToCsv(bs.liabilities.totalCents)],
        ['', 'Equity', ''], ...bs.equity.items.map(r),
        ['', 'Total equity', centsToCsv(bs.equity.totalCents)],
      ]));
    }
    return bs;
  });

  /** One account's postings with a running balance. */
  app.get('/api/reports/ledger', readers, async (req, reply) => {
    const { account, from, to, format } = q(req);
    const acc = z.string().uuid().safeParse(account);
    if (!acc.success) throw badRequest('Choose an account');
    const [a] = await sql<AccountRow[]>`select * from accounts where id = ${acc.data}`;
    if (!a) throw notFound('Account');
    const settings = await getSettings(sql);
    const t = isIsoDate(to) ? to : today();
    const fy = financialYear(t, settings.fyEndMonth);
    const f = isIsoDate(from) ? from : fy.start;
    const isPl = PL.includes(a.type);
    // P&L accounts start each financial year at zero.
    const openFrom = isPl ? financialYear(f, settings.fyEndMonth).start : null;
    const [opening] = await sql<{ total: number }[]>`
      select coalesce(sum(amount_cents), 0)::bigint as total from ledger
      where account_id = ${a.id} and date < ${f}::date and (${openFrom}::date is null or date >= ${openFrom}::date)`;
    const rows = await sql<{ date: string; amountCents: number; source: string; sourceId: string; memo: string; projectId: string | null }[]>`
      select l.date, l.amount_cents, l.source, l.source_id, l.memo, l.project_id, p.name as project_name
      from ledger l left join projects p on p.id = l.project_id
      where l.account_id = ${a.id} and l.date between ${f}::date and ${t}::date
      order by l.date, l.source, l.memo`;
    let bal = opening!.total;
    const out = rows.map((r) => ({ ...r, balanceCents: (bal += r.amountCents) }));
    if (format === 'csv') {
      return sendCsv(reply, `ledger-${a.code}-${f}-to-${t}.csv`, toCsv(['Date', 'Source', 'Description', 'Debit', 'Credit', 'Balance'], [
        [f, '', 'Opening balance', '', '', centsToCsv(opening!.total)],
        ...out.map((r) => [r.date, r.source, r.memo, r.amountCents > 0 ? centsToCsv(r.amountCents) : '', r.amountCents < 0 ? centsToCsv(-r.amountCents) : '', centsToCsv(r.balanceCents)]),
      ]));
    }
    return { account: a, from: f, to: t, openingCents: opening!.total, closingCents: bal, rows: out };
  });

  // ---- journals
  app.get('/api/journals', readers, async () => {
    return sql`
      select j.*, coalesce(sum(jl.debit_cents), 0)::bigint as total_cents, count(jl.id)::int as line_count
      from journals j left join journal_lines jl on jl.journal_id = j.id
      group by j.id order by j.date desc, j.created_at desc`;
  });
  app.get('/api/journals/:id', readers, async (req) => {
    const { id } = parse(idParam, req.params);
    const [journal] = await sql`select * from journals where id = ${id}`;
    if (!journal) throw notFound('Journal');
    const lines = await sql`select jl.*, a.code, a.name from journal_lines jl join accounts a on a.id = jl.account_id where jl.journal_id = ${id} order by jl.debit_cents desc, a.code`;
    return { journal, lines };
  });

  const checkJournal = (input: z.infer<typeof journalInput>) => {
    for (const l of input.lines) if ((l.debitCents > 0) === (l.creditCents > 0)) throw badRequest('Each line needs either a debit or a credit');
    const d = input.lines.reduce((s, l) => s + l.debitCents, 0);
    const c = input.lines.reduce((s, l) => s + l.creditCents, 0);
    if (d !== c) throw badRequest(`Debits and credits must be equal (out by R ${((d - c) / 100).toFixed(2)})`);
  };
  app.post('/api/journals', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(journalInput, req.body);
    checkJournal(input);
    await assertOpen(sql, input.date);
    const id = await sql.begin(async (tx) => {
      const [j] = await tx<{ id: string }[]>`insert into journals (date, description, reference, kind, created_by) values (${input.date}, ${input.description}, ${input.reference}, 'manual', ${user.id}) returning id`;
      for (const l of input.lines) await tx`insert into journal_lines ${tx({ ...l, journalId: j!.id })}`;
      await audit(tx, { userId: user.id, action: 'create', entity: 'journal', entityId: j!.id, ip: req.ip });
      return j!.id;
    });
    return { id };
  });
  app.put('/api/journals/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(journalInput, req.body);
    checkJournal(input);
    const [old] = await sql<{ date: string }[]>`select date from journals where id = ${id}`;
    if (!old) throw notFound('Journal');
    await assertOpen(sql, old.date, input.date);
    await sql.begin(async (tx) => {
      await tx`update journals set date = ${input.date}, description = ${input.description}, reference = ${input.reference} where id = ${id}`;
      await tx`delete from journal_lines where journal_id = ${id}`;
      for (const l of input.lines) await tx`insert into journal_lines ${tx({ ...l, journalId: id })}`;
      await audit(tx, { userId: user.id, action: 'update', entity: 'journal', entityId: id, ip: req.ip });
    });
    return { id };
  });
  app.delete('/api/journals/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ date: string }[]>`select date from journals where id = ${id}`;
    if (!old) throw notFound('Journal');
    await assertOpen(sql, old.date);
    await sql.begin(async (tx) => {
      await tx`delete from journals where id = ${id}`;
      await audit(tx, { userId: user.id, action: 'delete', entity: 'journal', entityId: id, ip: req.ip });
    });
    return { ok: true };
  });

  // ---- statement balance checks (bank, cards, the owner's loan)
  app.get('/api/balance-checks', readers, async () => {
    return sql`
      select b.*, a.code, a.name as account_name, a.type as account_type,
        ((case when a.type = 'asset' then 1 else -1 end)
          * (select coalesce(sum(l.amount_cents), 0) from ledger l where l.account_id = b.account_id and l.date <= b.date))::bigint as books_cents
      from balance_checks b join accounts a on a.id = b.account_id order by b.date desc, a.code`;
  });
  app.post('/api/balance-checks', owner, async (req) => {
    const input = parse(balanceCheckInput, req.body);
    const [row] = await sql`insert into balance_checks ${sql(input)} returning *`;
    return row;
  });
  app.delete('/api/balance-checks/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    await sql`delete from balance_checks where id = ${id}`;
    return { ok: true };
  });
  /**
   * Make the books agree with a statement: posts the difference against another account
   * (often the owner's loan for card and cash spending, or suspense to investigate).
   */
  app.post('/api/balance-checks/:id/adjust', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { againstAccountId } = parse(z.object({ againstAccountId: z.string().uuid() }), req.body);
    const [b] = await sql<{ accountId: string; date: string; statementBalanceCents: number; accountName: string; accountType: string; booksCents: number }[]>`
      select b.*, a.name as account_name, a.type as account_type,
        (select coalesce(sum(l.amount_cents), 0) from ledger l where l.account_id = b.account_id and l.date <= b.date)::bigint as books_cents
      from balance_checks b join accounts a on a.id = b.account_id where b.id = ${id}`;
    if (!b) throw notFound('Balance check');
    // Statement balances are entered the natural way round: money in the bank, or what a loan or card owes.
    // Turn that into the debit-positive figure the ledger uses before comparing.
    const target = b.accountType === 'asset' ? b.statementBalanceCents : -b.statementBalanceCents;
    const diff = target - b.booksCents;
    if (diff === 0) throw badRequest('The books already agree with this balance');
    if (againstAccountId === b.accountId) throw badRequest('Choose a different account to post the difference to');
    await assertOpen(sql, b.date);
    const jid = await sql.begin(async (tx) => {
      const [j] = await tx<{ id: string }[]>`
        insert into journals (date, description, reference, kind, created_by)
        values (${b.date}, ${`Agree ${b.accountName} to statement`}, 'Balance check', 'adjustment', ${user.id}) returning id`;
      await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents) values
        (${j!.id}, ${b.accountId}, ${diff > 0 ? diff : 0}, ${diff < 0 ? -diff : 0}),
        (${j!.id}, ${againstAccountId}, ${diff < 0 ? -diff : 0}, ${diff > 0 ? diff : 0})`;
      await audit(tx, { userId: user.id, action: 'adjust', entity: 'balance_check', entityId: id, ip: req.ip, details: { diff } });
      return j!.id;
    });
    return { journalId: jid, differenceCents: diff };
  });

  // ---- asset register
  app.get('/api/assets', readers, async (req) => {
    const d = q(req).date;
    const at = isIsoDate(d) ? d : today();
    return sql`
      select a.*, s.name as source_name, c.description as cost_description,
        is_intangible(a.category) as intangible,
        coalesce((select sum(-l.amount_cents) from ledger l where l.source in ('depreciation') and l.source_id = a.id
                  and l.account_id = accumulated_account(a.category) and l.date <= ${at}::date), 0)::bigint as accumulated_cents,
        coalesce((select sum(l.amount_cents) from ledger l where l.source = 'depreciation' and l.source_id = a.id
                  and l.account_id = writedown_account(a.category) and l.date <= ${at}::date
                  and l.date >= ${financialYear(at, (await getSettings(sql)).fyEndMonth).start}::date), 0)::bigint as depreciation_this_year_cents
      from assets a left join payment_sources s on s.id = a.source_id left join costs c on c.id = a.cost_id
      order by a.disposed_on nulls first, a.purchase_date desc`;
  });
  app.post('/api/assets', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(assetInput, req.body);
    if (!input.costId && !input.sourceId) throw badRequest('Say how it was paid for');
    await assertOpen(sql, input.purchaseDate, input.disposedOn);
    if (input.costId) {
      const [c] = await sql<{ amountCents: number; vatCents: number }[]>`select amount_cents, vat_cents from costs where id = ${input.costId}`;
      if (!c) throw notFound('Cost');
      input.costCents = c.amountCents - c.vatCents; // the cost entry is what posts; keep them equal
    }
    const [row] = await sql`insert into assets ${sql({ ...input, costId: input.costId ?? null, sourceId: input.costId ? null : (input.sourceId ?? null), disposedOn: input.disposedOn ?? null, disposalSourceId: input.disposalSourceId ?? null })} returning *`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'asset', entityId: row!.id, ip: req.ip });
    return row;
  });
  app.put('/api/assets/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(assetInput, req.body);
    const [old] = await sql<{ costId: string | null; purchaseDate: string }[]>`select cost_id, purchase_date from assets where id = ${id}`;
    if (!old) throw notFound('Asset');
    await assertOpen(sql, input.disposedOn);
    const costId = input.costId ?? old.costId;
    if (costId) {
      const [c] = await sql<{ amountCents: number; vatCents: number }[]>`select amount_cents, vat_cents from costs where id = ${costId}`;
      if (c) input.costCents = c.amountCents - c.vatCents;
    }
    const [row] = await sql`update assets set ${sql({ ...input, costId: costId ?? null, sourceId: costId ? null : (input.sourceId ?? null), disposedOn: input.disposedOn ?? null, disposalSourceId: input.disposalSourceId ?? null })} where id = ${id} returning *`;
    await audit(sql, { userId: user.id, action: 'update', entity: 'asset', entityId: id, ip: req.ip });
    return row;
  });
  app.delete('/api/assets/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const [old] = await sql<{ purchaseDate: string }[]>`select purchase_date from assets where id = ${id}`;
    if (!old) throw notFound('Asset');
    await assertOpen(sql, old.purchaseDate);
    await sql`delete from assets where id = ${id}`;
    await audit(sql, { userId: user.id, action: 'delete', entity: 'asset', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- raw exports for the accountant
  app.get('/api/export/:what', readers, async (req, reply) => {
    const { what } = parse(z.object({ what: z.enum(['costs', 'labour', 'invoices', 'receipts', 'wage-payments', 'ledger']) }), req.params);
    const settings = await getSettings(sql);
    const { from, to } = q(req);
    const fy = financialYear(today(), settings.fyEndMonth);
    const f = isIsoDate(from) ? from : fy.start;
    const t = isIsoDate(to) ? to : today();
    const name = `${what}-${f}-to-${t}.csv`;
    if (what === 'costs') {
      const rows = await sql`select c.date, c.description, c.supplier, k.name as category, s.name as source, p.number, p.name as project, c.amount_cents, c.vat_cents, c.note
        from costs c join cost_categories k on k.id = c.category_id left join payment_sources s on s.id = c.source_id left join projects p on p.id = c.project_id
        where c.date between ${f}::date and ${t}::date order by c.date`;
      return sendCsv(reply, name, toCsv(['Date', 'Description', 'Supplier', 'Category', 'Paid from', 'Job no.', 'Job', 'Amount', 'VAT', 'Note'],
        rows.map((r) => [r.date, r.description, r.supplier, r.category, r.source, r.number, r.project, centsToCsv(r.amountCents), centsToCsv(r.vatCents), r.note])));
    }
    if (what === 'labour') {
      const rows = await sql`select e.date, w.name as worker, p.number, coalesce(p.name, wt.name, 'Not allocated') as job, e.days, e.wage_cents, e.allowance_cents, e.note
        from labour_entries e join workers w on w.id = e.worker_id left join projects p on p.id = e.project_id left join work_types wt on wt.id = e.work_type_id
        where e.date between ${f}::date and ${t}::date order by e.date, w.name`;
      return sendCsv(reply, name, toCsv(['Date', 'Worker', 'Job no.', 'Job / general work', 'Days', 'Wage', 'Allowance', 'Total', 'Note'],
        rows.map((r) => [r.date, r.worker, r.number, r.job, r.days, centsToCsv(r.wageCents), centsToCsv(r.allowanceCents), centsToCsv(r.wageCents + r.allowanceCents), r.note])));
    }
    if (what === 'wage-payments') {
      const rows = await sql`select wp.date, w.name as worker, wp.amount_cents, s.name as source, wp.note from wage_payments wp join workers w on w.id = wp.worker_id join payment_sources s on s.id = wp.source_id
        where wp.date between ${f}::date and ${t}::date order by wp.date`;
      return sendCsv(reply, name, toCsv(['Date', 'Worker', 'Amount', 'Paid from', 'Note'], rows.map((r) => [r.date, r.worker, centsToCsv(r.amountCents), r.source, r.note])));
    }
    if (what === 'invoices') {
      const rows = await sql`select d.number, d.issue_date, d.due_date, case when d.written_off_on is not null then 'written off' else d.status end as status,
          c.name as client, p.name as project, d.subtotal_cents, d.vat_cents, d.total_cents, d.written_off_cents,
          coalesce((select sum(amount_cents) from receipts r where r.invoice_id = d.id), 0)::bigint as paid
        from documents d left join clients c on c.id = d.client_id left join projects p on p.id = d.project_id
        where d.kind = 'invoice' and d.issue_date between ${f}::date and ${t}::date order by d.issue_date, d.number`;
      return sendCsv(reply, name, toCsv(['Invoice', 'Date', 'Due', 'Status', 'Client', 'Job', 'Subtotal', 'VAT', 'Total', 'Paid', 'Written off', 'Balance'],
        rows.map((r) => [r.number, r.issueDate, r.dueDate, r.status, r.client, r.project, centsToCsv(r.subtotalCents), centsToCsv(r.vatCents), centsToCsv(r.totalCents), centsToCsv(r.paid), centsToCsv(r.writtenOffCents), centsToCsv(r.totalCents - r.paid - r.writtenOffCents)])));
    }
    if (what === 'receipts') {
      const rows = await sql`select r.date, d.number, c.name as client, r.amount_cents, s.name as source, r.method, r.reference from receipts r join documents d on d.id = r.invoice_id
        left join clients c on c.id = d.client_id join payment_sources s on s.id = r.source_id where r.date between ${f}::date and ${t}::date order by r.date`;
      return sendCsv(reply, name, toCsv(['Date', 'Invoice', 'Client', 'Amount', 'Received into', 'Method', 'Reference'],
        rows.map((r) => [r.date, r.number, r.client, centsToCsv(r.amountCents), r.source, r.method, r.reference])));
    }
    const rows = await sql`select l.date, a.code, a.name, l.source, l.memo, l.amount_cents from ledger l join accounts a on a.id = l.account_id
      where l.date between ${f}::date and ${t}::date order by l.date, l.source, l.source_id, a.code`;
    return sendCsv(reply, name, toCsv(['Date', 'Account code', 'Account', 'Source', 'Description', 'Debit', 'Credit'],
      rows.map((r) => [r.date, r.code, r.name, r.source, r.memo, r.amountCents > 0 ? centsToCsv(r.amountCents) : '', r.amountCents < 0 ? centsToCsv(-r.amountCents) : ''])));
  });
}
