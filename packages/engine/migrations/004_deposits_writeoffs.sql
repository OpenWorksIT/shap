-- Deposits on quotes and invoices, and writing off what a client will never pay.
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A deposit asked for up front: a percentage of the total, or a fixed amount (one or neither).
alter table documents
  add column deposit_bp int check (deposit_bp between 1 and 10000),
  add column deposit_cents bigint check (deposit_cents > 0),
  -- On an invoice: also print what remains once the deposit is in.
  add column deposit_show_balance boolean not null default true,
  -- Delinquent: the rest of this invoice is not expected. Written off as a bad debt on this date.
  add column written_off_on date,
  add column written_off_cents bigint not null default 0,
  add column written_off_reason text not null default '';

insert into accounts (code, name, type, system_key) values
  ('6170', 'Bad debts (invoices written off)', 'expense', 'bad_debts')
on conflict (code) do nothing;

-- The ledger gains the write-offs: bad debts up, debtors down, on the day it was written off.
drop view ledger;
alter view ledger_detail rename to ledger_core;

create view ledger_detail as
select * from ledger_core
union all
select d.written_off_on, sys_account('bad_debts'), d.written_off_cents, 'write_off'::text, d.id,
       'Written off: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and d.written_off_cents <> 0
union all
select d.written_off_on, sys_account('receivables'), -d.written_off_cents, 'write_off'::text, d.id,
       'Written off: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and d.written_off_cents <> 0;

-- Unchanged from 003: the accountant's agreed year ends on top of the detail.
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
  select fy_end, sys_account('suspense'), -sum(amount_cents)::bigint from adj group by fy_end having sum(amount_cents) <> 0
)
select * from ledger_detail
union all
select a.fy_end as date, a.account_id, a.amount_cents, 'year_end'::text as source, null::uuid as source_id,
       'Year-end adjustment to the accountant''s figures'::text as memo, null::uuid as project_id, null::uuid as client_id, null::uuid as worker_id
from adj_all a;
