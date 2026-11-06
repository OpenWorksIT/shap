-- Dividends declared (and a trust's distributions) are closed into retained earnings at each year
-- end, like the year's profit: the account shows only this year's, as an accountant's trial
-- balance does. Before, it carried every year's forward, so a second year agreed with the
-- accountant's "dividends this year" landed the difference in suspense.
--
-- Years already agreed keep exactly the adjustments they had: their dividends figure (the total
-- to date, as it was read) becomes the year's own, worked out from the same books.
with f as (
  select y.fy_end, y.account_id, y.amount_cents,
    (date_trunc('month', y.fy_end) - interval '11 months')::date as fy_start,
    (select max(p.fy_end) from year_end_figures p where p.account_id = y.account_id and p.fy_end < y.fy_end) as prev_end
  from year_end_figures y join accounts a on a.id = y.account_id where a.system_key = 'dividends'
)
update year_end_figures y set amount_cents = f.amount_cents
  - coalesce((select sum(d.amount_cents) from ledger_detail d where d.account_id = f.account_id and d.date < f.fy_start), 0)
  - coalesce((select p.amount_cents from year_end_figures p where p.fy_end = f.prev_end and p.account_id = f.account_id)
      - (select coalesce(sum(d.amount_cents), 0) from ledger_detail d where d.account_id = f.account_id and d.date <= f.prev_end), 0)
from f where y.fy_end = f.fy_end and y.account_id = f.account_id;

create or replace view ledger as
with
fig as (
  select f.fy_end, f.account_id, f.amount_cents, a.type,
         -- Income, costs and dividends are agreed for the year; everything else as a balance to date.
         (a.type in ('income', 'cost_of_sales', 'expense') or a.system_key = 'dividends') as yearly,
         (date_trunc('month', f.fy_end) - interval '11 months')::date as fy_start,
         (select max(p.fy_end) from year_end_figures p where p.account_id = f.account_id and p.fy_end < f.fy_end) as prev_end
  from year_end_figures f join accounts a on a.id = f.account_id
  where coalesce(a.system_key, '') not in ('retained_earnings', 'suspense')
),
adj as (
  select fig.fy_end, fig.account_id,
    case when fig.yearly then
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

update books_version set changed = changed + 1;
