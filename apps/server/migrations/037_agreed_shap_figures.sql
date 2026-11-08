-- The books audit (docs/AUDIT.md): Shap's own figure for each account of an agreed year, as it was
-- when the year was agreed. Shap keeps the agreed figures by adjusting each account to them at the
-- year end, so something dated in the year that's added or changed afterwards doesn't move them:
-- it shows as Shap's own figure differing from this.
alter table year_end_figures add column if not exists shap_cents bigint;

-- Years agreed before this version: measured from now on.
select fresh_ledger_totals();
update year_end_figures f set shap_cents = coalesce((
  select sum(l.amount_cents) from ledger_totals l join accounts a on a.id = l.account_id
  where l.account_id = f.account_id and l.date <= f.fy_end and not (l.source = 'year_end' and l.date = f.fy_end)
    and (not (a.type in ('income', 'cost_of_sales', 'expense') or coalesce(a.system_key, '') = 'dividends')
         or l.date >= (date_trunc('month', f.fy_end) - interval '11 months')::date)), 0)
where f.shap_cents is null;
