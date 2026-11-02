/**
 * Payroll: employees on a monthly salary, pay runs with PAYE, UIF and SDL, payslips, what's owed
 * to SARS each month (EMP201) and paying it. Dividends: paying the company's shareholders, with
 * 20% dividends tax withheld.
 *
 * Everything reaches the books as journals the app makes (journals.kind payroll / dividend /
 * sars, linked by source_id). A finalised pay run posts on its pay date:
 *
 *   Salaries (or Director's remuneration)  Dr gross
 *   UIF and SDL (employer)                 Dr employer UIF + SDL
 *     PAYE owed                            Cr PAYE
 *     UIF owed                             Cr employee + employer UIF
 *     SDL owed                             Cr SDL
 *     the bank (or wherever it's paid from) Cr net pay
 */
import {
  dividendInput,
  dividendTax,
  dwtDue,
  emp201Due,
  employeeInput,
  payLine,
  payLineInput,
  payRunInput,
  sarsPaymentInput,
  taxYearEnd,
  type AgeBand,
} from '@shap/shared';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { requireRole, userOrThrow } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Db, Tx } from '../db/index.js';
import type { FastifyInstance } from 'fastify';
import { audit } from '../lib/audit.js';
import { assertOpen, centsToCsv, getSettings, q, today, toCsv, freshTotals } from '../lib/books.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { shapFooter, usePdfFonts } from './pdf.js';

const idParam = z.object({ id: z.string().uuid() });

interface JournalLine {
  key: string;
  debit?: number;
  credit?: number;
  memo?: string;
}

/** Posts a journal by system account keys, leaving out zero lines. Returns its id. */
async function postJournal(tx: Tx, j: { date: string; description: string; reference?: string; kind: 'payroll' | 'dividend' | 'sars'; sourceId: string; userId: string; lines: JournalLine[] }) {
  const [row] = await tx<{ id: string }[]>`
    insert into journals (date, description, reference, kind, source_id, created_by)
    values (${j.date}, ${j.description}, ${j.reference ?? ''}, ${j.kind}, ${j.sourceId}, ${j.userId}) returning id`;
  for (const l of j.lines) {
    const d = Math.round(l.debit ?? 0);
    const c = Math.round(l.credit ?? 0);
    if (!d && !c) continue;
    const [acc] = await tx<{ id: string }[]>`select id from accounts where system_key = ${l.key} or id::text = ${l.key} limit 1`;
    if (!acc) throw new Error(`No account ${l.key}`);
    await tx`insert into journal_lines (journal_id, account_id, debit_cents, credit_cents, memo) values (${row!.id}, ${acc.id}, ${d}, ${c}, ${l.memo ?? ''})`;
  }
  return row!.id;
}

const sourceAccount = async (db: Db, sourceId: string) => {
  const [s] = await db<{ accountId: string; name: string }[]>`select account_id, name from payment_sources where id = ${sourceId}`;
  if (!s) throw badRequest('Choose where it’s paid from');
  return s;
};

interface EmployeeRow {
  id: string;
  name: string;
  isDirector: boolean;
  salaryCents: number;
  ageBand: AgeBand;
  medicalMembers: number;
  uif: boolean;
  startDate: string;
  endDate: string | null;
  active: boolean;
}

/** Works out one line from the employee and the month's figures. */
function compute(e: EmployeeRow, salaryCents: number, extraCents: number, payDate: string, sdl: boolean) {
  return payLine({ salaryCents, extraCents, payDate, age: e.ageBand, medicalMembers: e.medicalMembers, uif: e.uif, sdl });
}

async function recomputeRun(tx: Tx, runId: string) {
  const [run] = await tx<{ payDate: string }[]>`select pay_date::text from pay_runs where id = ${runId}`;
  const settings = await getSettings(tx);
  const lines = await tx<{ id: string; salaryCents: number; extraCents: number; employeeId: string }[]>`select id, salary_cents, extra_cents, employee_id from pay_lines where run_id = ${runId}`;
  for (const l of lines) {
    const [e] = await tx<EmployeeRow[]>`select * from employees where id = ${l.employeeId}`;
    const r = compute(e!, l.salaryCents, l.extraCents, run!.payDate, settings.sdl);
    await tx`update pay_lines set is_director = ${e!.isDirector}, gross_cents = ${r.grossCents}, paye_cents = ${r.payeCents}, uif_employee_cents = ${r.uifEmployeeCents},
      uif_employer_cents = ${r.uifEmployerCents}, sdl_cents = ${r.sdlCents}, net_cents = ${r.netCents} where id = ${l.id}`;
  }
}

const runTotals = `
  coalesce(sum(l.gross_cents), 0)::bigint as gross_cents, coalesce(sum(l.paye_cents), 0)::bigint as paye_cents,
  coalesce(sum(l.uif_employee_cents + l.uif_employer_cents), 0)::bigint as uif_cents, coalesce(sum(l.sdl_cents), 0)::bigint as sdl_cents,
  coalesce(sum(l.net_cents), 0)::bigint as net_cents, count(l.id)::int as people`;

/** What's owed to SARS, month by month: payroll (EMP201) and dividends tax. */
export async function sarsSummary(db: Db) {
  const emp = await db.unsafe<{ period: string; payeCents: number; uifCents: number; sdlCents: number; paidCents: number }[]>(`
    select r.period, sum(l.paye_cents)::bigint as paye_cents, sum(l.uif_employee_cents + l.uif_employer_cents)::bigint as uif_cents, sum(l.sdl_cents)::bigint as sdl_cents,
      coalesce((select sum(p.amount_cents) from sars_payments p where p.kind = 'emp201' and p.period = r.period), 0)::bigint as paid_cents
    from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'final' group by r.period order by r.period desc`);
  const dwt = await db.unsafe<{ period: string; dwtCents: number; paidCents: number }[]>(`
    select m.period, m.dwt_cents,
      coalesce((select sum(p.amount_cents) from sars_payments p where p.kind = 'dwt' and p.period = m.period), 0)::bigint as paid_cents
    from (select to_char(d.paid_on, 'YYYY-MM') as period, sum(d.dwt_cents)::bigint as dwt_cents
          from dividends d where d.paid_on is not null and d.dwt_cents > 0 group by 1) m
    order by m.period desc`);
  return {
    emp201: emp.map((r) => ({ ...r, totalCents: r.payeCents + r.uifCents + r.sdlCents, dueOn: emp201Due(r.period) })),
    dividendsTax: dwt.map((r) => ({ ...r, dueOn: dwtDue(`${r.period}-01`) })),
  };
}

/** Profits the company can still pay out: all profit ever, less dividends already declared. */
export async function distributable(db: Db): Promise<number> {
  await freshTotals(db);
  const [r] = await db<{ t: number }[]>`
    select coalesce(sum(l.amount_cents), 0)::bigint as t from ledger_totals l join accounts a on a.id = l.account_id
    where a.type in ('income', 'cost_of_sales', 'expense') or a.system_key in ('retained_earnings', 'dividends')`;
  return -Number(r!.t);
}

/** Payroll matters for Home: SARS payments coming due or late. */
export async function payrollAttention(db: Db, on = today()) {
  const s = await sarsSummary(db);
  const due = [
    ...s.emp201.filter((r) => r.paidCents < r.totalCents).map((r) => ({ kind: 'emp201' as const, period: r.period, owingCents: r.totalCents - r.paidCents, dueOn: r.dueOn })),
    ...s.dividendsTax.filter((r) => r.paidCents < r.dwtCents).map((r) => ({ kind: 'dwt' as const, period: r.period, owingCents: r.dwtCents - r.paidCents, dueOn: r.dueOn })),
  ];
  return due.map((d) => ({ ...d, late: d.dueOn < on })).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

export function registerPayrollRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { sql } = ctx;
  const owner = { preHandler: requireRole('owner') };
  const readers = { preHandler: requireRole('owner', 'accountant') };

  // ---------------------------------------------------------------- employees
  app.get('/api/employees', readers, async () => sql`select * from employees order by active desc, name`);

  app.post('/api/employees', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(employeeInput, req.body);
    const [row] = await sql<{ id: string }[]>`insert into employees ${sql(input as never)} returning id`;
    await audit(sql, { userId: user.id, action: 'create', entity: 'employee', entityId: row!.id, ip: req.ip });
    return row;
  });

  app.put('/api/employees/:id', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(employeeInput, req.body);
    const r = await sql`update employees set ${sql(input as never)} where id = ${id}`;
    if (!r.count) throw notFound('Employee');
    // Draft pay runs pick up the change.
    await sql.begin(async (tx) => {
      for (const run of await tx<{ id: string }[]>`select r.id from pay_runs r join pay_lines l on l.run_id = r.id where r.status = 'draft' and l.employee_id = ${id}`) await recomputeRun(tx, run.id);
    });
    await audit(sql, { userId: user.id, action: 'update', entity: 'employee', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---------------------------------------------------------------- pay runs
  app.get('/api/pay-runs', readers, async () =>
    sql.unsafe(`select r.id, r.period, r.pay_date, r.status, r.source_id, ${runTotals} from pay_runs r left join pay_lines l on l.run_id = r.id group by r.id order by r.period desc`),
  );

  app.post('/api/pay-runs', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(payRunInput, req.body);
    await sourceAccount(sql, input.sourceId);
    const monthEnd = new Date(Date.UTC(Number(input.period.slice(0, 4)), Number(input.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const monthStart = `${input.period}-01`;
    const id = await sql.begin(async (tx) => {
      const [exists] = await tx`select 1 from pay_runs where period = ${input.period}`;
      if (exists) throw conflict(`There’s already a pay run for ${input.period}`);
      const [run] = await tx<{ id: string }[]>`insert into pay_runs (period, pay_date, source_id, created_by) values (${input.period}, ${input.payDate}, ${input.sourceId}, ${user.id}) returning id`;
      const people = await tx<EmployeeRow[]>`
        select * from employees where active and start_date <= ${monthEnd}::date and (end_date is null or end_date >= ${monthStart}::date) order by name`;
      if (!people.length) throw badRequest('Add an employee first (and check their start date)');
      for (const e of people) await tx`insert into pay_lines (run_id, employee_id, salary_cents) values (${run!.id}, ${e.id}, ${e.salaryCents})`;
      await recomputeRun(tx, run!.id);
      return run!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'pay_run', entityId: id, ip: req.ip, details: { period: input.period } });
    return { id };
  });

  const loadRun = async (db: Db, id: string) => {
    const [run] = await db.unsafe<{ id: string; period: string; payDate: string; status: string; sourceId: string; journalId: string | null }[]>(
      `select id, period, pay_date::text, status, source_id, journal_id from pay_runs where id = $1`,
      [id],
    );
    if (!run) throw notFound('Pay run');
    const lines = await db<{ employeeId: string; name: string; [k: string]: unknown }[]>`
      select l.*, e.name, e.id_number, e.tax_number from pay_lines l join employees e on e.id = l.employee_id where l.run_id = ${id} order by e.name`;
    return { run, lines };
  };

  app.get('/api/pay-runs/:id', readers, async (req) => loadRun(sql, parse(idParam, req.params).id));

  const draft = async (db: Db, id: string) => {
    const [r] = await db<{ status: string }[]>`select status from pay_runs where id = ${id}`;
    if (!r) throw notFound('Pay run');
    if (r.status !== 'draft') throw badRequest('This pay run is final. Reopen it to change it.');
  };

  app.put('/api/pay-runs/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(payRunInput.omit({ period: true }), req.body);
    await draft(sql, id);
    await sourceAccount(sql, input.sourceId);
    await sql.begin(async (tx) => {
      await tx`update pay_runs set pay_date = ${input.payDate}, source_id = ${input.sourceId} where id = ${id}`;
      await recomputeRun(tx, id);
    });
    return loadRun(sql, id);
  });

  app.put('/api/pay-runs/:id/lines/:employeeId', owner, async (req) => {
    const { id, employeeId } = parse(z.object({ id: z.string().uuid(), employeeId: z.string().uuid() }), req.params);
    const input = parse(payLineInput, req.body);
    await draft(sql, id);
    await sql.begin(async (tx) => {
      const r = await tx`update pay_lines set salary_cents = ${input.salaryCents}, extra_cents = ${input.extraCents}, note = ${input.note} where run_id = ${id} and employee_id = ${employeeId}`;
      if (!r.count) throw notFound('Employee in this pay run');
      await recomputeRun(tx, id);
    });
    return loadRun(sql, id);
  });

  app.delete('/api/pay-runs/:id/lines/:employeeId', owner, async (req) => {
    const { id, employeeId } = parse(z.object({ id: z.string().uuid(), employeeId: z.string().uuid() }), req.params);
    await draft(sql, id);
    await sql`delete from pay_lines where run_id = ${id} and employee_id = ${employeeId}`;
    return loadRun(sql, id);
  });

  app.post('/api/pay-runs/:id/finalise', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    await draft(sql, id);
    const { run, lines } = await loadRun(sql, id);
    if (!lines.length) throw badRequest('Nobody is being paid in this run');
    await assertOpen(sql, run.payDate);
    const src = await sourceAccount(sql, run.sourceId);
    const sum = (k: string, director?: boolean) => lines.filter((l) => director === undefined || Boolean(l.isDirector) === director).reduce((s, l) => s + Number(l[k] ?? 0), 0);
    await sql.begin(async (tx) => {
      const journalId = await postJournal(tx, {
        date: run.payDate,
        description: `Payroll ${run.period}`,
        kind: 'payroll',
        sourceId: id,
        userId: user.id,
        lines: [
          { key: 'salaries', debit: sum('grossCents', false), memo: 'Salaries' },
          { key: 'director_salary', debit: sum('grossCents', true), memo: 'Director’s remuneration' },
          { key: 'payroll_levies', debit: sum('uifEmployerCents') + sum('sdlCents'), memo: 'Employer UIF and SDL' },
          { key: 'paye_payable', credit: sum('payeCents'), memo: 'PAYE' },
          { key: 'uif_payable', credit: sum('uifEmployeeCents') + sum('uifEmployerCents'), memo: 'UIF' },
          { key: 'sdl_payable', credit: sum('sdlCents'), memo: 'SDL' },
          { key: src.accountId, credit: sum('netCents'), memo: `Net pay from ${src.name}` },
        ],
      });
      await tx`update pay_runs set status = 'final', journal_id = ${journalId} where id = ${id}`;
    });
    await audit(sql, { userId: user.id, action: 'finalise', entity: 'pay_run', entityId: id, ip: req.ip, details: { period: run.period } });
    return loadRun(sql, id);
  });

  app.post('/api/pay-runs/:id/reopen', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const { run } = await loadRun(sql, id);
    if (run.status !== 'final') return loadRun(sql, id);
    await assertOpen(sql, run.payDate);
    await sql.begin(async (tx) => {
      await tx`delete from journals where kind = 'payroll' and source_id = ${id}`;
      await tx`update pay_runs set status = 'draft', journal_id = null where id = ${id}`;
    });
    await audit(sql, { userId: user.id, action: 'reopen', entity: 'pay_run', entityId: id, ip: req.ip });
    return loadRun(sql, id);
  });

  app.delete('/api/pay-runs/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    await draft(sql, id);
    await sql`delete from pay_runs where id = ${id}`;
    return { ok: true };
  });

  app.get('/api/pay-runs/:id/payslip/:employeeId', readers, async (req, reply) => {
    const { id, employeeId } = parse(z.object({ id: z.string().uuid(), employeeId: z.string().uuid() }), req.params);
    const { run, lines } = await loadRun(sql, id);
    const line = lines.find((l) => l.employeeId === employeeId);
    if (!line) throw notFound('Payslip');
    const yearEnd = taxYearEnd(run.payDate);
    const yearStart = `${Number(yearEnd.slice(0, 4)) - 1}-03-01`;
    const [ytd] = await sql<{ gross: number; paye: number; uif: number }[]>`
      select coalesce(sum(l.gross_cents), 0)::bigint as gross, coalesce(sum(l.paye_cents), 0)::bigint as paye, coalesce(sum(l.uif_employee_cents), 0)::bigint as uif
      from pay_lines l join pay_runs r on r.id = l.run_id
      where l.employee_id = ${employeeId} and r.pay_date between ${yearStart}::date and ${run.payDate}::date and (r.status = 'final' or r.id = ${id})`;
    const settings = await getSettings(sql);
    const pdf = await renderPayslip({ settings, run, line: line as never, ytd: ytd! });
    const name = `Payslip ${run.period} - ${line.name}.pdf`.replace(/[^\w.\- ]/g, '');
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${name}"`);
    return reply.send(pdf);
  });

  // ---------------------------------------------------------------- SARS
  app.get('/api/payroll/sars', readers, async () => sarsSummary(sql));

  app.post('/api/sars-payments', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(sarsPaymentInput, req.body);
    await assertOpen(sql, input.date);
    const src = await sourceAccount(sql, input.sourceId);
    const s = await sarsSummary(sql);
    const id = await sql.begin(async (tx) => {
      const [p] = await tx<{ id: string }[]>`insert into sars_payments ${tx({ ...input, createdBy: user.id } as never)} returning id`;
      let lines: JournalLine[];
      if (input.kind === 'emp201') {
        const m = s.emp201.find((r) => r.period === input.period);
        if (!m) throw badRequest(`No final pay run for ${input.period}`);
        // Paid in order: PAYE, then UIF, then SDL; anything over sits against PAYE.
        let left = input.amountCents;
        const take = (n: number) => {
          const t = Math.min(left, n);
          left -= t;
          return t;
        };
        const paye = take(m.payeCents);
        const uif = take(m.uifCents);
        const sdl = take(m.sdlCents);
        lines = [
          { key: 'paye_payable', debit: paye + left, memo: 'PAYE' },
          { key: 'uif_payable', debit: uif, memo: 'UIF' },
          { key: 'sdl_payable', debit: sdl, memo: 'SDL' },
          { key: src.accountId, credit: input.amountCents, memo: `Paid from ${src.name}` },
        ];
      } else {
        lines = [
          { key: 'dwt_payable', debit: input.amountCents, memo: 'Dividends tax' },
          { key: src.accountId, credit: input.amountCents, memo: `Paid from ${src.name}` },
        ];
      }
      const journalId = await postJournal(tx, {
        date: input.date,
        description: input.kind === 'emp201' ? `SARS: PAYE, UIF and SDL for ${input.period}` : `SARS: dividends tax for ${input.period}`,
        reference: input.reference,
        kind: 'sars',
        sourceId: p!.id,
        userId: user.id,
        lines,
      });
      await tx`update sars_payments set journal_id = ${journalId} where id = ${p!.id}`;
      return p!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'sars_payment', entityId: id, ip: req.ip, details: { kind: input.kind, period: input.period } });
    return { id };
  });

  app.get('/api/sars-payments', readers, async () => sql`select p.*, s.name as source_name from sars_payments p join payment_sources s on s.id = p.source_id order by p.date desc`);

  app.delete('/api/sars-payments/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const [p] = await sql<{ date: string }[]>`select date::text from sars_payments where id = ${id}`;
    if (!p) throw notFound('Payment');
    await assertOpen(sql, p.date);
    await sql.begin(async (tx) => {
      await tx`delete from journals where kind = 'sars' and source_id = ${id}`;
      await tx`delete from sars_payments where id = ${id}`;
    });
    return { ok: true };
  });

  /** A tax year's totals per employee: what goes on their IRP5 and the EMP501 reconciliation. */
  app.get('/api/payroll/year', readers, async (req, reply) => {
    const yearEnd = taxYearEnd(q(req).date ?? today());
    const yearStart = `${Number(yearEnd.slice(0, 4)) - 1}-03-01`;
    const rows = await sql<{ name: string; idNumber: string; taxNumber: string; gross: number; paye: number; uifEmployee: number; uifEmployer: number; sdl: number; net: number; months: number }[]>`
      select e.name, e.id_number, e.tax_number, sum(l.gross_cents)::bigint as gross, sum(l.paye_cents)::bigint as paye, sum(l.uif_employee_cents)::bigint as uif_employee,
        sum(l.uif_employer_cents)::bigint as uif_employer, sum(l.sdl_cents)::bigint as sdl, sum(l.net_cents)::bigint as net, count(*)::int as months
      from pay_lines l join pay_runs r on r.id = l.run_id join employees e on e.id = l.employee_id
      where r.status = 'final' and r.pay_date between ${yearStart}::date and ${yearEnd}::date
      group by e.id order by e.name`;
    if (q(req).format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="payroll-tax-year-${yearEnd.slice(0, 4)}.csv"`);
      return reply.send(
        toCsv(
          ['Employee', 'ID number', 'Tax number', 'Months', 'Gross pay', 'PAYE', 'UIF (employee)', 'UIF (employer)', 'SDL', 'Net pay'],
          rows.map((r) => [r.name, r.idNumber, r.taxNumber, r.months, centsToCsv(r.gross), centsToCsv(r.paye), centsToCsv(r.uifEmployee), centsToCsv(r.uifEmployer), centsToCsv(r.sdl), centsToCsv(r.net)]),
        ),
      );
    }
    return { yearStart, yearEnd, rows };
  });

  // ---------------------------------------------------------------- dividends
  app.get('/api/dividends', readers, async () => ({
    dividends: await sql`select d.*, s.name as source_name from dividends d left join payment_sources s on s.id = d.source_id order by d.declared_on desc, d.created_at desc`,
    availableCents: await distributable(sql),
  }));

  const payDividend = async (tx: Tx, d: { id: string; grossCents: number; dwtCents: number; netCents: number; shareholder: string }, paidOn: string, sourceId: string, userId: string) => {
    const src = await sourceAccount(tx, sourceId);
    return postJournal(tx, {
      date: paidOn,
      description: `Dividend paid to ${d.shareholder}`,
      kind: 'dividend',
      sourceId: d.id,
      userId,
      lines: [
        { key: 'dividends_payable', debit: d.grossCents, memo: 'Dividend' },
        { key: 'dwt_payable', credit: d.dwtCents, memo: 'Dividends tax withheld (20%)' },
        { key: src.accountId, credit: d.netCents, memo: `Paid from ${src.name}` },
      ],
    });
  };

  app.post('/api/dividends', owner, async (req) => {
    const user = userOrThrow(req);
    const input = parse(dividendInput, req.body);
    const settings = await getSettings(sql);
    if (settings.businessType !== 'company') throw badRequest('Only a company pays dividends. As a sole proprietor, money you take out is drawings.');
    if (input.paidOn && !input.sourceId) throw badRequest('Choose where it’s paid from');
    if (input.paidOn && input.paidOn < input.declaredOn) throw badRequest('It can’t be paid before it’s declared');
    await assertOpen(sql, input.declaredOn, input.paidOn);
    const dwt = dividendTax(input.grossCents, input.exempt);
    const id = await sql.begin(async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        insert into dividends (declared_on, paid_on, shareholder, gross_cents, exempt, dwt_cents, net_cents, source_id, note, created_by)
        values (${input.declaredOn}, ${input.paidOn}, ${input.shareholder}, ${input.grossCents}, ${input.exempt}, ${dwt}, ${input.grossCents - dwt}, ${input.sourceId}, ${input.note}, ${user.id}) returning id`;
      const declared = await postJournal(tx, {
        date: input.declaredOn,
        description: `Dividend declared to ${input.shareholder}`,
        kind: 'dividend',
        sourceId: d!.id,
        userId: user.id,
        lines: [
          { key: 'dividends', debit: input.grossCents, memo: 'Dividend declared' },
          { key: 'dividends_payable', credit: input.grossCents, memo: 'Owed to the shareholder' },
        ],
      });
      const paid = input.paidOn ? await payDividend(tx, { id: d!.id, grossCents: input.grossCents, dwtCents: dwt, netCents: input.grossCents - dwt, shareholder: input.shareholder }, input.paidOn, input.sourceId!, user.id) : null;
      await tx`update dividends set journal_id = ${declared}, paid_journal_id = ${paid} where id = ${d!.id}`;
      return d!.id;
    });
    await audit(sql, { userId: user.id, action: 'create', entity: 'dividend', entityId: id, ip: req.ip, details: { grossCents: input.grossCents } });
    return { id };
  });

  app.post('/api/dividends/:id/pay', owner, async (req) => {
    const user = userOrThrow(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sourceId: z.string().uuid() }), req.body);
    const [d] = await sql<{ id: string; declaredOn: string; paidOn: string | null; grossCents: number; dwtCents: number; netCents: number; shareholder: string }[]>`
      select id, declared_on::text, paid_on::text, gross_cents, dwt_cents, net_cents, shareholder from dividends where id = ${id}`;
    if (!d) throw notFound('Dividend');
    if (d.paidOn) throw badRequest('This dividend has been paid');
    if (input.paidOn < d.declaredOn) throw badRequest('It can’t be paid before it’s declared');
    await assertOpen(sql, input.paidOn);
    await sql.begin(async (tx) => {
      const paid = await payDividend(tx, d, input.paidOn, input.sourceId, user.id);
      await tx`update dividends set paid_on = ${input.paidOn}, source_id = ${input.sourceId}, paid_journal_id = ${paid} where id = ${id}`;
    });
    return { ok: true };
  });

  app.delete('/api/dividends/:id', owner, async (req) => {
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ declaredOn: string; paidOn: string | null }[]>`select declared_on::text, paid_on::text from dividends where id = ${id}`;
    if (!d) throw notFound('Dividend');
    await assertOpen(sql, d.declaredOn, d.paidOn);
    await sql.begin(async (tx) => {
      await tx`delete from journals where kind = 'dividend' and source_id = ${id}`;
      await tx`delete from dividends where id = ${id}`;
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- payslip
const money = (c: number) => `R ${(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, ' ')}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function renderPayslip(d: {
  settings: Awaited<ReturnType<typeof getSettings>>;
  run: { period: string; payDate: string };
  line: { name: string; idNumber: string; taxNumber: string; isDirector: boolean; salaryCents: number; extraCents: number; grossCents: number; payeCents: number; uifEmployeeCents: number; uifEmployerCents: number; sdlCents: number; netCents: number; note: string };
  ytd: { gross: number; paye: number; uif: number };
}): Promise<Buffer> {
  const { settings, run, line, ytd } = d;
  const pdf = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 }, info: { Title: `Payslip ${run.period} ${line.name}` } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const f = usePdfFonts(pdf);
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent ?? '') ? settings.accent : '#e8731c';
  const L = 48;
  const W = pdf.page.width - 96;
  const name = settings.tradingName || settings.companyName;
  const [y, m] = run.period.split('-').map(Number) as [number, number];

  pdf.font(f.bold).fontSize(20).fillColor(accent).text('Payslip', L, 48, { width: W, align: 'right' });
  pdf.font(f.bold).fontSize(14).fillColor('#1d262c').text(name, L, 50, { width: W / 2 });
  pdf.font(f.regular).fontSize(9).fillColor('#66737b').text([settings.address, settings.regNumber ? `Reg. ${settings.regNumber}` : ''].filter(Boolean).join('\n'), L, pdf.y + 2, { width: W / 2 });
  pdf.font(f.regular).fontSize(10).fillColor('#1d262c').text(`${MONTH_NAMES[m - 1]} ${y}\nPaid ${run.payDate}`, L, 76, { width: W, align: 'right' });

  let top = Math.max(pdf.y, 120) + 16;
  pdf.moveTo(L, top).lineTo(L + W, top).strokeColor(accent).lineWidth(1.5).stroke();
  top += 12;
  pdf.font(f.bold).fontSize(12).fillColor('#1d262c').text(line.name, L, top);
  pdf.font(f.regular).fontSize(9).fillColor('#66737b').text([line.isDirector ? 'Director' : 'Employee', line.idNumber ? `ID ${line.idNumber}` : '', line.taxNumber ? `Tax no. ${line.taxNumber}` : ''].filter(Boolean).join(' · '), L, pdf.y + 2);
  top = pdf.y + 18;

  const table = (title: string, rows: [string, number][], at: number) => {
    pdf.font(f.bold).fontSize(8).fillColor('#66737b').text(title.toUpperCase(), L, at, { characterSpacing: 0.8 });
    let yy = pdf.y + 6;
    for (const [label, cents] of rows) {
      pdf.font(f.regular).fontSize(10).fillColor('#1d262c').text(label, L, yy, { width: W - 140 });
      pdf.text(money(cents), L + W - 140, yy, { width: 140, align: 'right' });
      yy += 18;
    }
    return yy + 8;
  };
  top = table('Earnings', [['Salary', line.salaryCents], ...(line.extraCents ? ([[line.note || 'Bonus / overtime', line.extraCents]] as [string, number][]) : [])], top);
  top = table('Deductions', [['PAYE (income tax)', line.payeCents], ['UIF (1%)', line.uifEmployeeCents]], top);

  pdf.rect(L, top, W, 34).fill(accent);
  pdf.font(f.bold).fontSize(12).fillColor('#ffffff').text('Net pay', L + 12, top + 11);
  pdf.text(money(line.netCents), L + W - 212, top + 11, { width: 200, align: 'right' });
  top += 52;

  top = table('Paid by the employer (not deducted)', [['UIF (employer, 1%)', line.uifEmployerCents], ...(line.sdlCents ? ([['Skills Development Levy (1%)', line.sdlCents]] as [string, number][]) : [])], top);
  table('This tax year so far', [['Gross pay', ytd.gross], ['PAYE', ytd.paye], ['UIF', ytd.uif]], top);

  pdf.page.margins.bottom = 0;
  pdf.font(f.regular).fontSize(8).fillColor('#66737b').text(`PAYE on SARS’s tables for the year ending ${taxYearEnd(run.payDate)}.`, L, pdf.page.height - 70, { width: W, align: 'center' });
  if (settings.watermark) shapFooter(pdf, L, pdf.page.height - 40, W, f.regular);
  pdf.end();
  return done;
}
