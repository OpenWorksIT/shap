-- Writing off a bad debt claims back the VAT in it (VAT201 field 17, s22 of the VAT Act), so the
-- write-off now posts that VAT to the VAT account and only the rest to bad debts:
--
--   Bad debts                Dr  written off less its VAT
--   VAT                      Dr  the VAT in what was written off
--     Debtors                Cr  written off
--
-- Before, the whole amount went to bad debts while the VAT201 claimed the VAT back as well, so the
-- VAT account didn't agree with the return and bad debts were overstated by the VAT.
--
-- Write-offs in years already closed stay posted as they were: those books were signed off.
alter table documents add column if not exists written_off_vat_relief boolean not null default true;
update documents d set written_off_vat_relief = false
from settings s
where s.id and s.lock_date is not null and d.written_off_on is not null and d.written_off_on <= s.lock_date;

create or replace view ledger_detail as
select * from ledger_core
union all
select d.written_off_on, sys_account('bad_debts'), d.written_off_cents - w.vat, 'write_off'::text, d.id,
       'Written off: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
cross join lateral (select case when d.written_off_vat_relief and d.vat_rate_bp > 0
                                then round(d.written_off_cents * d.vat_rate_bp::numeric / (10000 + d.vat_rate_bp))::bigint
                                else 0::bigint end as vat) w
where d.kind = 'invoice' and d.status = 'issued' and d.written_off_on is not null and d.written_off_cents - w.vat <> 0
union all
select d.written_off_on, sys_account('vat'), w.vat, 'write_off'::text, d.id,
       'VAT claimed back on bad debt: invoice ' || d.number, d.project_id, d.client_id, null::uuid
from documents d
cross join lateral (select case when d.written_off_vat_relief and d.vat_rate_bp > 0
                                then round(d.written_off_cents * d.vat_rate_bp::numeric / (10000 + d.vat_rate_bp))::bigint
                                else 0::bigint end as vat) w
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
from bill_payments bp join costs c on c.id = bp.cost_id join payment_sources s on s.id = bp.source_id;

update books_version set changed = changed + 1;
