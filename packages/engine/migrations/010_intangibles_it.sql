-- Intangible assets (patents & trade marks, software licences) with their own amortisation,
-- and cost types for software subscriptions and hosting.
-- SPDX-License-Identifier: AGPL-3.0-or-later

alter table assets drop constraint assets_category_check;
alter table assets add constraint assets_category_check
  check (category in ('tools', 'vehicles', 'equipment', 'computers', 'other', 'patents', 'software'));

-- 1550–1599 sit under non-current assets on the balance sheet, as intangible assets.
insert into accounts (code, name, type, system_key) values
  ('1550', 'Patents & trade marks at cost', 'asset', 'intangible_patents'),
  ('1560', 'Software licences at cost', 'asset', 'intangible_software'),
  ('1595', 'Accumulated amortisation', 'asset', 'accumulated_amortisation'),
  ('6155', 'Amortisation', 'expense', 'amortisation'),
  ('6180', 'Software & subscriptions', 'expense', 'software'),
  ('6190', 'Hosting, servers & domains', 'expense', 'hosting')
on conflict (code) do nothing;

-- Ready-made cost types for the two new expense accounts.
insert into cost_categories (name, kind, account_id, sort)
select v.name, 'overhead', a.id, v.sort from (values
  ('Software & subscriptions', 'software', 60),
  ('Hosting, servers & domains', 'hosting', 61)) as v(name, key, sort)
join accounts a on a.system_key = v.key
where not exists (select 1 from cost_categories c where lower(c.name) = lower(v.name));

create or replace function asset_account(category text) returns uuid language sql stable as $$
  select case when category is null then null
              when category = 'vehicles' then sys_account('fixed_assets_vehicles')
              when category = 'patents' then sys_account('intangible_patents')
              when category = 'software' then sys_account('intangible_software')
              else sys_account('fixed_assets') end
$$;

create function is_intangible(category text) returns boolean language sql immutable as $$
  select category in ('patents', 'software')
$$;

-- Where an asset's yearly write-down goes: depreciation, or amortisation for intangibles.
create function writedown_account(category text) returns uuid language sql stable as $$
  select case when is_intangible(category) then sys_account('amortisation') else sys_account('depreciation') end
$$;
create function accumulated_account(category text) returns uuid language sql stable as $$
  select case when is_intangible(category) then sys_account('accumulated_amortisation') else sys_account('accumulated_depreciation') end
$$;
create function writedown_label(category text) returns text language sql immutable as $$
  select case when is_intangible(category) then 'Amortisation: ' else 'Depreciation: ' end
$$;

-- The ledger as in 003 (renamed ledger_core in 004), with write-downs by kind of asset.
create or replace view ledger_core as
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
select c.date, coalesce(s.account_id, sys_account('uncaptured')), -c.amount_cents, 'cost', c.id,
       c.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, c.project_id, p.client_id, null
from costs c left join payment_sources s on s.id = c.source_id left join projects p on p.id = c.project_id

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

-- Depreciation (amortisation for intangible assets)
union all
select dep.date, writedown_account(dep.category), dep.amount, 'depreciation', dep.asset_id, writedown_label(dep.category) || dep.name, null, null, null
from dep
union all
select dep.date, accumulated_account(dep.category), -dep.amount, 'depreciation', dep.asset_id, writedown_label(dep.category) || dep.name, null, null, null
from dep

-- Selling or scrapping an asset: take it off the books, profit or loss on the difference
union all
select x.disposed_on, x.account_id, x.amount, 'disposal', x.id, 'Sold/scrapped: ' || x.name, null, null, null
from (
  select a.id, a.name, a.disposed_on,
         unnest(array[asset_account(a.category), accumulated_account(a.category),
                      coalesce(s.account_id, sys_account('bank')), sys_account('disposal_gain_loss')]) as account_id,
         unnest(array[-a.cost_cents, acc.total, a.disposal_proceeds_cents,
                      a.cost_cents - acc.total - a.disposal_proceeds_cents]) as amount
  from assets a
  left join payment_sources s on s.id = a.disposal_source_id
  cross join lateral (select coalesce(sum(d.amount), 0)::bigint as total from dep d where d.asset_id = a.id) acc
  where a.disposed_on is not null
) x where x.amount <> 0;
