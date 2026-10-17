-- Trading names, costs not yet captured, agreed year ends and provisional tax.
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- ---------------------------------------------------------------- trading names
-- One company can trade under several names (e.g. "Construction Solutions" and "OpenWorks IT").
-- Each has its own logo, contacts and bank details on quotes and invoices; everything else
-- (numbering, jobs, the books) is shared.
create table brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  legal_line text not null default '',
  email text not null default '',
  phone text not null default '',
  website text not null default '',
  address text not null default '',
  bank_details text not null default '',
  logo_id uuid references attachments(id),
  accent text not null default '#e8731c',
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table settings add column default_brand_id uuid references brands(id);
alter table projects add column brand_id uuid references brands(id);
alter table documents add column brand_id uuid references brands(id);
alter table clients add column brand_id uuid references brands(id);

-- The company's existing letterhead becomes its first trading name.
insert into brands (name, legal_line, email, phone, website, address, bank_details, logo_id, sort)
select coalesce(nullif(trading_name, ''), company_name),
       case when trading_name <> '' and trading_name <> company_name then company_name || ' t/a ' || trading_name else '' end,
       email, phone, website, address, bank_details, logo_id, 1
from settings;
update settings set default_brand_id = (select id from brands limit 1);

-- ---------------------------------------------------------------- costs not captured yet
-- A cost whose payment source isn't known yet (a blank "Account" in the tracker) waits in a
-- clearing account until you say which bank account or card paid it.
alter table costs alter column source_id drop not null;
insert into accounts (code, name, type, system_key) values
  ('2050', 'Costs not yet matched to a payment', 'liability', 'uncaptured'),
  ('6160', 'Director''s remuneration', 'expense', 'director_salary')
on conflict (code) do nothing;

-- ---------------------------------------------------------------- agreed year ends
-- The accountant's final figures for a closed financial year. For each account listed, the
-- closing balance (balance-sheet accounts) or the year's total (income and expense accounts)
-- is made to equal the figure here. The difference is posted live as a year-end adjustment,
-- so the year stays agreed whatever happens to the detail later.
create table year_ends (
  fy_end date primary key,
  note text not null default '',
  created_at timestamptz not null default now()
);
create table year_end_figures (
  fy_end date not null references year_ends(fy_end) on delete cascade,
  account_id uuid not null references accounts(id),
  amount_cents bigint not null,          -- debit positive, as in the ledger
  primary key (fy_end, account_id)
);

-- Provisional tax estimates (IRP6 workings), kept so you can see what you told SARS.
create table tax_estimates (
  id uuid primary key default gen_random_uuid(),
  fy_end date not null,
  period int not null check (period in (1, 2, 3)),
  as_at date not null,
  lines jsonb not null default '[]',
  taxable_income_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  payable_cents bigint not null default 0,
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

drop view ledger;

create view ledger_detail as
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

-- The ledger: the detail, plus the adjustments that make each agreed year equal the accountant's figures.
-- Only accounts with a figure for that year are adjusted (the app saves every account, so a year
-- agreed in the app is agreed in full). Balance-sheet adjustments carry forward: each one tops up
-- whatever the earlier agreed years already adjusted.
create view ledger as
with
fig as (
  select f.fy_end, f.account_id, f.amount_cents, a.type,
         (date_trunc('month', f.fy_end) - interval '11 months')::date as fy_start,
         (select max(p.fy_end) from year_end_figures p where p.account_id = f.account_id and p.fy_end < f.fy_end) as prev_end
  from year_end_figures f join accounts a on a.id = f.account_id
  where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
),
adj as (
  select fig.fy_end, fig.account_id,
    case when fig.type in ('income', 'cost_of_sales', 'expense') then
      fig.amount_cents
        - coalesce((select sum(d.amount_cents) from ledger_detail d where d.account_id = fig.account_id and d.date between fig.fy_start and fig.fy_end), 0)
    else
      (fig.amount_cents
        - coalesce((select sum(d.amount_cents) from ledger_detail d where d.account_id = fig.account_id and d.date <= fig.fy_end), 0))
      - case when fig.prev_end is null then 0 else
          (select p.amount_cents from year_end_figures p where p.fy_end = fig.prev_end and p.account_id = fig.account_id)
          - coalesce((select sum(d.amount_cents) from ledger_detail d where d.account_id = fig.account_id and d.date <= fig.prev_end), 0)
        end
    end::bigint as amount_cents
  from fig
),
adj_all as (
  select fy_end, account_id, amount_cents from adj where amount_cents <> 0
  union all
  -- Anything that doesn't balance (figures that don't add up) lands in suspense, in plain sight.
  select fy_end, sys_account('suspense'), -sum(amount_cents)::bigint from adj group by fy_end having sum(amount_cents) <> 0
)
select * from ledger_detail
union all
select a.fy_end as date, a.account_id, a.amount_cents, 'year_end'::text as source, null::uuid as source_id,
       'Year-end adjustment to the accountant''s figures'::text as memo, null::uuid as project_id, null::uuid as client_id, null::uuid as worker_id
from adj_all a;
