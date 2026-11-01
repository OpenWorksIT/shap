-- The general ledger, read live from the source records.
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- One row per posting. amount_cents > 0 is a debit, < 0 a credit.
-- Every source posts a balanced set of rows, so the ledger always sums to zero
-- (the tests check this after importing a whole tracker).

-- Job costs (labour and materials/demo bought for a job) are matched to the job's invoice:
-- while a job isn't invoiced they sit in Work in progress on the balance sheet, and on the
-- invoice date they move to cost of sales, so each month shows a job's income and its costs
-- together (as the tracker's Trade Statement did). A cost dated after the job's last invoice
-- waits for the next invoice, or counts on its own date once the job is marked done or cancelled.

create function sys_account(key text) returns uuid language sql stable as $$
  select id from accounts where system_key = key
$$;

create function asset_account(category text) returns uuid language sql stable as $$
  select case when category is null then null
              when category = 'vehicles' then sys_account('fixed_assets_vehicles')
              else sys_account('fixed_assets') end
$$;

create function job_cost_recognised_on(p_project uuid, p_date date) returns date language sql stable as $$
  select coalesce(
    (select min(d.issue_date) from documents d
     where d.project_id = p_project and d.kind = 'invoice' and d.status = 'issued' and d.issue_date >= p_date),
    (select p_date from projects p where p.id = p_project and p.status in ('done', 'cancelled')))
$$;

create view ledger as
with
inv as (
  select * from documents where kind = 'invoice' and status = 'issued'
),
dep_plan as (
  -- Straight-line monthly depreciation from the end of the purchase month, stopping
  -- after the asset's life or once it is sold or scrapped.
  select a.id as asset_id, a.name, a.category,
         (date_trunc('month', a.purchase_date) + (m + 1) * interval '1 month' - interval '1 day')::date as date,
         case when m = a.life_months - 1
              then (a.cost_cents - a.residual_cents) - ((a.cost_cents - a.residual_cents) / a.life_months) * (a.life_months - 1)
              else (a.cost_cents - a.residual_cents) / a.life_months end as amount
  from assets a
  cross join lateral generate_series(0, a.life_months - 1) as m
  where a.cost_cents > a.residual_cents
),
dep as (
  select d.* from dep_plan d join assets a on a.id = d.asset_id
  where a.disposed_on is null or d.date < a.disposed_on
),
cst as (
  select c.*, p.client_id,
    coalesce(asset_account(a.category), cat.account_id) as expense_account,
    (c.project_id is not null and cat.kind in ('materials', 'demo') and a.id is null) as job_cost,
    c.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end as memo
  from costs c join cost_categories cat on cat.id = c.category_id
  left join assets a on a.cost_id = c.id left join projects p on p.id = c.project_id
),
cst_rec as (
  select cst.*, case when job_cost then job_cost_recognised_on(project_id, date) else date end as recognised_on from cst
),
lab as (
  select e.*, p.client_id, w.name || ' – ' || coalesce(p.name, wt.name, 'not allocated') as memo,
    case when e.project_id is null then sys_account('general_labour') else sys_account('cos_labour') end as expense_account,
    case when e.project_id is null then e.date else job_cost_recognised_on(e.project_id, e.date) end as recognised_on
  from labour_entries e join workers w on w.id = e.worker_id
  left join projects p on p.id = e.project_id left join work_types wt on wt.id = e.work_type_id
  where e.wage_cents + e.allowance_cents <> 0
)
-- Invoices: debtors up, revenue by category, VAT owed
select inv.issue_date as date, sys_account('receivables') as account_id, inv.total_cents as amount_cents,
       'invoice'::text as source, inv.id as source_id, ('Invoice ' || inv.number) as memo,
       inv.project_id, inv.client_id, null::uuid as worker_id
from inv where inv.total_cents <> 0
union all
select inv.issue_date, sys_account('revenue_' || l.category), (-sum(l.line_total_cents))::bigint,
       'invoice', inv.id, 'Invoice ' || inv.number, inv.project_id, inv.client_id, null
from inv join document_lines l on l.document_id = inv.id
group by inv.id, inv.issue_date, inv.number, inv.project_id, inv.client_id, l.category
having sum(l.line_total_cents) <> 0
union all
select inv.issue_date, sys_account('vat'), -inv.vat_cents, 'invoice', inv.id, 'VAT on invoice ' || inv.number,
       inv.project_id, inv.client_id, null
from inv where inv.vat_cents <> 0

-- Payments received: into the bank (or wherever), debtors down
union all
select r.date, s.account_id, r.amount_cents, 'receipt', r.id, 'Payment for invoice ' || d.number, d.project_id, d.client_id, null
from receipts r join documents d on d.id = r.invoice_id join payment_sources s on s.id = r.source_id
union all
select r.date, sys_account('receivables'), -r.amount_cents, 'receipt', r.id, 'Payment for invoice ' || d.number, d.project_id, d.client_id, null
from receipts r join documents d on d.id = r.invoice_id

-- Costs: the category's account (or the asset account when capitalised), paid from a source.
-- Job costs not yet matched to an invoice wait in Work in progress.
union all
select date, case when recognised_on = date then expense_account else sys_account('wip') end,
       amount_cents - vat_cents, 'cost', id, memo, project_id, client_id, null
from cst_rec where amount_cents - vat_cents <> 0
union all
select recognised_on, sys_account('wip'), -(amount_cents - vat_cents), 'cost', id, memo || ' (to cost of sales)', project_id, client_id, null
from cst_rec where recognised_on > date and amount_cents - vat_cents <> 0
union all
select recognised_on, expense_account, amount_cents - vat_cents, 'cost', id, memo || ' (to cost of sales)', project_id, client_id, null
from cst_rec where recognised_on > date and amount_cents - vat_cents <> 0
union all
select c.date, sys_account('vat'), c.vat_cents, 'cost', c.id, 'VAT on ' || c.description, c.project_id, p.client_id, null
from costs c left join projects p on p.id = c.project_id where c.vat_cents <> 0
union all
select c.date, s.account_id, -c.amount_cents, 'cost', c.id,
       c.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, c.project_id, p.client_id, null
from costs c join payment_sources s on s.id = c.source_id left join projects p on p.id = c.project_id

-- Labour earned: a job cost (or general labour), owed to the worker
union all
select date, case when recognised_on = date then expense_account else sys_account('wip') end,
       wage_cents + allowance_cents, 'labour', id, memo, project_id, client_id, worker_id
from lab
union all
select recognised_on, sys_account('wip'), -(wage_cents + allowance_cents), 'labour', id, memo || ' (to cost of sales)', project_id, client_id, worker_id
from lab where recognised_on > date
union all
select recognised_on, expense_account, wage_cents + allowance_cents, 'labour', id, memo || ' (to cost of sales)', project_id, client_id, worker_id
from lab where recognised_on > date
union all
select date, sys_account('wages_payable'), -(wage_cents + allowance_cents), 'labour', id, memo, project_id, client_id, worker_id
from lab

-- Wages paid: less owed to the worker, out of a source
union all
select wp.date, sys_account('wages_payable'), wp.amount_cents, 'wage_payment', wp.id, 'Paid ' || w.name, null, null, wp.worker_id
from wage_payments wp join workers w on w.id = wp.worker_id
union all
select wp.date, s.account_id, -wp.amount_cents, 'wage_payment', wp.id, 'Paid ' || w.name, null, null, wp.worker_id
from wage_payments wp join workers w on w.id = wp.worker_id join payment_sources s on s.id = wp.source_id

-- Journals
union all
select j.date, jl.account_id, jl.debit_cents - jl.credit_cents, 'journal', j.id,
       j.description || case when jl.memo <> '' then ' – ' || jl.memo else '' end, null, null, null
from journals j join journal_lines jl on jl.journal_id = j.id

-- Assets bought directly from a source (not through a cost entry)
union all
select a.purchase_date, asset_account(a.category), a.cost_cents, 'asset', a.id, 'Asset: ' || a.name, null, null, null
from assets a where a.cost_id is null
union all
select a.purchase_date, coalesce(s.account_id, sys_account('owner_loan')), -a.cost_cents, 'asset', a.id, 'Asset: ' || a.name, null, null, null
from assets a left join payment_sources s on s.id = a.source_id where a.cost_id is null

-- Depreciation
union all
select dep.date, sys_account('depreciation'), dep.amount, 'depreciation', dep.asset_id, 'Depreciation: ' || dep.name, null, null, null
from dep
union all
select dep.date, sys_account('accumulated_depreciation'), -dep.amount, 'depreciation', dep.asset_id, 'Depreciation: ' || dep.name, null, null, null
from dep

-- Selling or scrapping an asset: take it off the books, profit or loss on the difference
union all
select x.disposed_on, x.account_id, x.amount, 'disposal', x.id, 'Sold/scrapped: ' || x.name, null, null, null
from (
  select a.id, a.name, a.disposed_on,
         unnest(array[asset_account(a.category), sys_account('accumulated_depreciation'),
                      coalesce(s.account_id, sys_account('bank')), sys_account('disposal_gain_loss')]) as account_id,
         unnest(array[-a.cost_cents, acc.total, a.disposal_proceeds_cents,
                      a.cost_cents - acc.total - a.disposal_proceeds_cents]) as amount
  from assets a
  left join payment_sources s on s.id = a.disposal_source_id
  cross join lateral (select coalesce(sum(d.amount), 0)::bigint as total from dep d where d.asset_id = a.id) acc
  where a.disposed_on is not null
) x where x.amount <> 0;
