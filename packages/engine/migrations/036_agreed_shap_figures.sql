-- The books audit (docs/AUDIT.md): Shap's own figure for each account of an agreed year, as it was
-- when the year was agreed: what was posted to it within the year, without any year-end
-- adjustment. Shap keeps the agreed figures by adjusting each account to them at the year end, so
-- something dated in the year that's added or changed afterwards doesn't move them: it shows as
-- Shap's own figure differing from this (lib/books.ts noteShapFigures).
alter table year_end_figures add column if not exists shap_cents bigint;

-- Years agreed before this version: measured from now on.
select fresh_ledger_totals();
update year_end_figures f set shap_cents = coalesce((
  select sum(l.amount_cents) from ledger_totals l
  where l.account_id = f.account_id and l.source <> 'year_end'
    and l.date between (date_trunc('month', f.fy_end) - interval '11 months')::date and f.fy_end), 0)
where f.shap_cents is null;
