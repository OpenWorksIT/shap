-- VAT per line (the accountant's review): each line of a quote, invoice or credit note says what
-- kind of supply it is (standard-rated, zero-rated, exported or exempt), and prices can be typed
-- including VAT. A line's total stays excluding VAT, so the books post revenue as before; the
-- VAT201 splits fields 1, 2, 2A and 3 by line. Costs and bills say what VAT was on them too.
alter table document_lines add column if not exists vat_code text not null default 'standard';
do $$ begin
  alter table document_lines add constraint document_lines_vat_code check (vat_code in ('standard', 'zero', 'export', 'exempt'));
exception when duplicate_object then null; end $$;
alter table documents add column if not exists prices_include_vat boolean not null default false;

alter table costs add column if not exists vat_code text not null default 'standard';
do $$ begin
  alter table costs add constraint costs_vat_code check (vat_code in ('standard', 'zero', 'exempt', 'no_vat', 'not_claimable'));
exception when duplicate_object then null; end $$;
-- Costs from before: VAT claimed means standard-rated; none means no VAT was claimed on it.
update costs set vat_code = 'no_vat' where vat_cents = 0 and vat_code = 'standard';

-- Invoices a VAT vendor issued at 0% before this (the only way to zero-rate one then): their
-- lines become zero-rated at the standard rate of their date, so they keep counting as zero-rated
-- supplies (VAT201 field 2) and reprint as tax invoices. Nothing they charged changes. Those from
-- before the business's first invoice with VAT were issued before it registered: they stay at 0%
-- and aren't on any VAT return. Credit notes follow the invoice they credit.
do $$
declare first_vat date;
begin
  if (select vat_registered from settings where id) then
    select min(issue_date) into first_vat from documents where kind = 'invoice' and status <> 'draft' and vat_rate_bp > 0;
    if first_vat is not null then
      update document_lines l set vat_code = 'zero' from documents d
        where l.document_id = d.id and d.kind = 'invoice' and d.status <> 'draft' and d.vat_rate_bp = 0 and d.issue_date >= first_vat;
      update documents set vat_rate_bp = case when issue_date >= '2018-04-01' then 1500 else 1400 end
        where kind = 'invoice' and status <> 'draft' and vat_rate_bp = 0 and issue_date >= first_vat;
      update document_lines l set vat_code = 'zero' from documents c join documents i on i.id = c.credited_invoice_id
        where l.document_id = c.id and c.kind = 'credit_note' and c.vat_rate_bp = 0 and i.vat_rate_bp > 0;
      update documents c set vat_rate_bp = i.vat_rate_bp from documents i
        where i.id = c.credited_invoice_id and c.kind = 'credit_note' and c.vat_rate_bp = 0 and i.vat_rate_bp > 0;
    end if;
  end if;
end $$;

-- The VAT inside a written-off amount (claimed back, VAT201 field 17): at the invoice's rate when
-- every line was standard-rated (as before). When it mixed standard-rated with zero-rated or
-- exempt lines, in proportion to the VAT still in the debt: the invoice's VAT and total less the
-- credit notes issued against it (a credit note can take back only the standard-rated part).
create or replace function bad_debt_vat(p_id uuid, p_written_off bigint, p_rate integer, p_vat bigint, p_total bigint) returns bigint
language sql stable as $$
  select case
    when p_rate = 0 or p_written_off = 0 then 0::bigint
    when exists (select 1 from document_lines l where l.document_id = p_id and l.vat_code <> 'standard') then (
      select case when p_total - cn.total <= 0 or p_vat - cn.vat <= 0 then 0::bigint
                  else least(round(p_written_off * (p_vat - cn.vat)::numeric / (p_total - cn.total)), p_vat - cn.vat)::bigint end
      from (select coalesce(sum(c.vat_cents), 0) as vat, coalesce(sum(c.total_cents), 0) as total
              from documents c where c.credited_invoice_id = p_id and c.kind = 'credit_note' and c.status = 'issued') cn)
    else round(p_written_off * p_rate::numeric / (10000 + p_rate))::bigint
  end
$$;

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
from bill_payments bp join costs c on c.id = bp.cost_id join payment_sources s on s.id = bp.source_id;

update books_version set changed = changed + 1;
