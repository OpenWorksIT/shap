-- The ledger with sales, refunds and stock (docs/SALES_AND_STOCK.md): a sale posts like an
-- invoice paid on the spot; a refund pays a credit note back out of the till or bank; every stock
-- movement posts the inventory account at cost against its other side; supplier claims and their
-- settlements post through the claims account.
create or replace view ledger_core as
with
inv as (
  -- Invoices and sales (a sale is an invoice paid on the spot, without a client needed).
  select *, case when kind = 'sale' then 'Sale ' else 'Invoice ' end || number as label
  from documents where kind in ('invoice', 'sale') and status = 'issued'
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
       'invoice'::text as source, inv.id as source_id, inv.label as memo,
       inv.project_id, inv.client_id, null::uuid as worker_id
from inv where inv.total_cents <> 0
union all
select inv.issue_date, sys_account('revenue_' || l.category), (-sum(l.line_total_cents))::bigint,
       'invoice', inv.id, inv.label, inv.project_id, inv.client_id, null
from inv join document_lines l on l.document_id = inv.id
group by inv.id, inv.issue_date, inv.label, inv.project_id, inv.client_id, l.category
having sum(l.line_total_cents) <> 0
union all
select inv.issue_date, sys_account('vat'), -inv.vat_cents, 'invoice', inv.id, 'VAT on ' || lower(inv.label),
       inv.project_id, inv.client_id, null
from inv where inv.vat_cents <> 0

-- Payments received: into the bank (or wherever), debtors down
union all
select r.date, s.account_id, r.amount_cents, 'receipt', r.id, case when d.kind = 'sale' then 'Paid: sale ' else 'Payment for invoice ' end || d.number, d.project_id, d.client_id, null
from receipts r join documents d on d.id = r.invoice_id join payment_sources s on s.id = r.source_id
union all
select r.date, sys_account('receivables'), -r.amount_cents, 'receipt', r.id, case when d.kind = 'sale' then 'Paid: sale ' else 'Payment for invoice ' end || d.number, d.project_id, d.client_id, null
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

-- Assets bought directly from a source (not through a cost entry): the asset at its cost before
-- VAT, the VAT claimed back, the whole amount out of the source
union all
select a.purchase_date, asset_account(a.category), a.cost_cents, 'asset', a.id, 'Asset: ' || a.name, null, null, null
from assets a where a.cost_id is null
union all
select a.purchase_date, sys_account('vat'), a.vat_cents, 'asset', a.id, 'VAT on asset: ' || a.name, null, null, null
from assets a where a.cost_id is null and a.vat_cents <> 0
union all
select a.purchase_date, coalesce(s.account_id, sys_account('owner_loan')), -(a.cost_cents + a.vat_cents), 'asset', a.id, 'Asset: ' || a.name, null, null, null
from assets a left join payment_sources s on s.id = a.source_id where a.cost_id is null

-- Depreciation (amortisation for intangible assets)
union all
select dep.date, writedown_account(dep.category), dep.amount, 'depreciation', dep.asset_id, writedown_label(dep.category) || dep.name, null, null, null
from dep
union all
select dep.date, accumulated_account(dep.category), -dep.amount, 'depreciation', dep.asset_id, writedown_label(dep.category) || dep.name, null, null, null
from dep

-- Selling or scrapping an asset: take it off the books, the VAT charged on the sale owed to SARS,
-- profit or loss on the difference (before VAT)
union all
select x.disposed_on, x.account_id, x.amount, 'disposal', x.id, 'Sold/scrapped: ' || x.name, null, null, null
from (
  select a.id, a.name, a.disposed_on,
         unnest(array[asset_account(a.category), accumulated_account(a.category),
                      coalesce(s.account_id, sys_account('bank')), sys_account('vat'), sys_account('disposal_gain_loss')]) as account_id,
         unnest(array[-a.cost_cents, acc.total, a.disposal_proceeds_cents, -a.disposal_vat_cents,
                      a.cost_cents - acc.total - (a.disposal_proceeds_cents - a.disposal_vat_cents)]) as amount
  from assets a
  left join payment_sources s on s.id = a.disposal_source_id
  cross join lateral (select coalesce(sum(d.amount), 0)::bigint as total from dep d where d.asset_id = a.id) acc
  where a.disposed_on is not null
) x where x.amount <> 0;;

create or replace view ledger_detail as
select * from ledger_core
union all
select d.written_off_on, sys_account('bad_debts'), d.written_off_cents - w.vat, 'write_off'::text, d.id,
       'Written off: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
cross join lateral (select case when d.written_off_vat_relief then bad_debt_vat(d.id, d.written_off_cents, d.vat_rate_bp, d.vat_cents, d.total_cents) else 0::bigint end as vat) w
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and d.written_off_cents - w.vat <> 0
union all
select d.written_off_on, sys_account('vat'), w.vat, 'write_off'::text, d.id,
       'VAT claimed back on bad debt: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
cross join lateral (select case when d.written_off_vat_relief then bad_debt_vat(d.id, d.written_off_cents, d.vat_rate_bp, d.vat_cents, d.total_cents) else 0::bigint end as vat) w
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and w.vat <> 0
union all
select d.written_off_on, sys_account('receivables'), -d.written_off_cents, 'write_off'::text, d.id,
       'Written off: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and d.written_off_cents <> 0
union all
select d.issue_date, sys_account('revenue_' || l.category), sum(l.line_total_cents)::bigint, 'credit_note'::text, d.id,
       'Credit note ' || d.number, d.project_id, d.client_id, null::uuid
from documents d join document_lines l on l.document_id = d.id
where d.kind = 'credit_note' and d.status = 'issued'
group by d.id, d.issue_date, d.number, d.project_id, d.client_id, l.category
having sum(l.line_total_cents) <> 0
union all
select d.issue_date, sys_account('vat'), d.vat_cents, 'credit_note'::text, d.id, 'VAT on credit note ' || d.number, d.project_id, d.client_id, null::uuid
from documents d where d.kind = 'credit_note' and d.status = 'issued' and d.vat_cents <> 0
union all
select d.issue_date, sys_account('credit_clearing'), -d.total_cents, 'credit_note'::text, d.id, 'Credit note ' || d.number, d.project_id, d.client_id, null::uuid
from documents d where d.kind = 'credit_note' and d.status = 'issued' and d.total_cents <> 0
union all
select bp.date, sys_account('payables'), bp.amount_cents, 'bill_payment'::text, bp.id,
       'Paid bill: ' || c.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, c.project_id, null::uuid, null::uuid
from bill_payments bp join costs c on c.id = bp.cost_id
union all
select bp.date, s.account_id, -bp.amount_cents, 'bill_payment'::text, bp.id,
       'Paid bill: ' || c.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, c.project_id, null::uuid, null::uuid
from bill_payments bp join costs c on c.id = bp.cost_id join payment_sources s on s.id = bp.source_id

-- Refunds: a credit note paid back in money, out of the till or the bank
union all
select rf.date, sys_account('credit_clearing'), rf.amount_cents, 'refund'::text, rf.id, 'Refund: credit note ' || d.number, d.project_id, d.client_id, null::uuid
from refunds rf join documents d on d.id = rf.credit_note_id
union all
select rf.date, s.account_id, -rf.amount_cents, 'refund'::text, rf.id, 'Refund: credit note ' || d.number, d.project_id, d.client_id, null::uuid
from refunds rf join documents d on d.id = rf.credit_note_id join payment_sources s on s.id = rf.source_id

-- Stock: each movement at cost, the inventory against the other side (stock purchases clearing,
-- a claim against the supplier, cost of sales, stock losses, or the opening balances)
union all
select m.date, sys_account('inventory'), m.value_cents, 'stock'::text, m.id, 'Stock: ' || i.description || ' (' || m.kind || ')', d.project_id, d.client_id, null::uuid
from stock_moves m join items i on i.id = m.item_id left join documents d on d.id = m.document_id
where m.value_cents <> 0
union all
select m.date, sys_account(m.contra), -m.value_cents, 'stock'::text, m.id, 'Stock: ' || i.description || ' (' || m.kind || ')', d.project_id, d.client_id, null::uuid
from stock_moves m join items i on i.id = m.item_id left join documents d on d.id = m.document_id
where m.value_cents <> 0

-- Stock invoiced but not delivered: owed back by the supplier, out of stock purchases clearing
union all
select c.date, sys_account('supplier_claims'), c.value_cents, 'stock_claim'::text, c.id, 'Short supplied: ' || i.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, null::uuid, null::uuid, null::uuid
from stock_claims c join items i on i.id = c.item_id where c.kind = 'short'
union all
select c.date, sys_account('stock_clearing'), -c.value_cents, 'stock_claim'::text, c.id, 'Short supplied: ' || i.description || case when c.supplier <> '' then ' – ' || c.supplier else '' end, null::uuid, null::uuid, null::uuid
from stock_claims c join items i on i.id = c.item_id where c.kind = 'short'

-- A claim settled: by the supplier's credit (out of stock purchases clearing, where the credit
-- landed) or written off; the part of a credit beyond any claim lowers the cost of sales.
union all
select x.date, case when x.kind = 'write_off' then sys_account('stock_losses') else sys_account('stock_clearing') end, x.amount_cents,
       'stock_claim'::text, x.id, case x.kind when 'credit' then 'Supplier credit on a claim' when 'write_off' then 'Claim written off' else 'Supplier discount on stock' end, null::uuid, null::uuid, null::uuid
from stock_claim_settlements x
union all
select x.date, case when x.kind = 'discount' then sys_account('cos_goods') else sys_account('supplier_claims') end, -x.amount_cents,
       'stock_claim'::text, x.id, case x.kind when 'credit' then 'Supplier credit on a claim' when 'write_off' then 'Claim written off' else 'Supplier discount on stock' end, null::uuid, null::uuid, null::uuid
from stock_claim_settlements x;

-- What these tables post changes the books: the report totals are worked out again after any
-- change to them, as for every other table the ledger reads (019_ledger_totals).
do $$
declare t text;
begin
  foreach t in array array['stock_moves', 'stock_claims', 'stock_claim_settlements', 'refunds']
  loop
    execute format('drop trigger if exists %I on %I', t || '_books_changed', t);
    execute format('create trigger %I after insert or update or delete or truncate on %I for each statement execute function books_changed()',
                   t || '_books_changed', t);
  end loop;
end
$$;

update books_version set changed = changed + 1;
