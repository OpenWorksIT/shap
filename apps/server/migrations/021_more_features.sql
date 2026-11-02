-- More of what small businesses asked for, each switched on in Settings:
-- credit notes, pro-forma invoices, PayShap details, payment reminders, the VAT201 layout,
-- turnover tax, supplier bills, a SARS travel logbook and a time tracker.

-- ---------------------------------------------------------------- documents
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('quote', 'invoice', 'credit_note'));
alter table documents drop constraint documents_check;
alter table documents add constraint documents_check check (
  (kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
  or (kind in ('invoice', 'credit_note') and status in ('draft', 'issued', 'void')));
-- A pro-forma invoice is a quote that asks to be paid: titled "Pro-forma invoice", with the bank details.
alter table documents add column proforma boolean not null default false;
-- A credit note reduces one invoice; issuing it settles that much of the invoice.
alter table documents add column credited_invoice_id uuid references documents(id);
alter table documents add column credit_reason text not null default '';
alter table receipts drop constraint receipts_method_check;
alter table receipts add constraint receipts_method_check check (method in ('eft', 'cash', 'card', 'other', 'credit'));
alter table documents add column credit_receipt_id uuid references receipts(id) on delete set null;
-- Payment reminders sent from the phone or browser.
alter table documents add column reminded_at timestamptz;
alter table documents add column reminders int not null default 0;
create index documents_credited on documents (credited_invoice_id) where credited_invoice_id is not null;

alter table settings add column credit_prefix text not null default 'CN';
alter table settings add column credit_next int not null default 1;
alter table settings add column credit_pad int not null default 4;
alter table settings add column proforma_prefix text not null default 'PF';
alter table settings add column proforma_next int not null default 1;
-- PayShap: the ShapID (or cellphone number) clients pay to, printed on invoices.
alter table settings add column payshap_id text not null default '';
-- VAT returns every two months (category A: Jan, Mar…; B: Feb, Apr…) or monthly (C).
alter table settings add column vat_category text not null default 'B' check (vat_category in ('A', 'B', 'C'));
alter table settings add column turnover_tax boolean not null default false;

-- Payment sources Shap uses itself: credit notes, and bills not paid yet.
alter table payment_sources add column role text check (role in ('credit_notes', 'bills'));
insert into accounts (code, name, type, system_key) values ('2450', 'Credit notes issued (clearing)', 'liability', 'credit_clearing')
on conflict (code) do nothing;
update accounts set system_key = 'payables' where code = '2000' and system_key is null;
insert into payment_sources (name, kind, account_id, active, sort, role)
select 'Credit notes', 'other', id, false, 90, 'credit_notes' from accounts where system_key = 'credit_clearing'
on conflict (name) do nothing;
insert into payment_sources (name, kind, account_id, active, sort, role)
select 'Not paid yet (a bill)', 'other', id, true, 91, 'bills' from accounts where system_key = 'payables'
on conflict (name) do nothing;

-- ---------------------------------------------------------------- supplier bills
-- A bill is a cost "paid from" the suppliers' account: the expense and VAT on the bill's date,
-- owed until it's paid. Paying it moves the money from the bank to the supplier.
alter table costs add column bill_number text not null default '';
alter table costs add column due_date date;
create table bill_payments (
  id uuid primary key default gen_random_uuid(),
  cost_id uuid not null references costs(id) on delete cascade,
  date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  source_id uuid not null references payment_sources(id),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index bill_payments_cost on bill_payments (cost_id);

-- ---------------------------------------------------------------- travel logbook (SARS)
create table trips (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  from_place text not null default '',
  to_place text not null default '',
  reason text not null default '',
  km numeric(8, 1) not null check (km >= 0),
  business boolean not null default true,
  project_id uuid references projects(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  created_at timestamptz not null default now()
);
create index trips_date on trips (date);
-- Odometer readings at the start and end of each tax year (1 March and the end of February).
create table logbook_years (
  year_end date primary key,
  vehicle text not null default '',
  odometer_start numeric(9, 1),
  odometer_end numeric(9, 1)
);

-- ---------------------------------------------------------------- time tracker
alter table projects add column hourly_rate_cents bigint not null default 0;
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  minutes int,
  note text not null default '',
  billed_document_id uuid references documents(id) on delete set null,
  created_at timestamptz not null default now()
);
create index time_entries_project on time_entries (project_id);
-- At most one clock running.
create unique index time_entries_running on time_entries ((true)) where ended_at is null;

-- ---------------------------------------------------------------- the ledger
-- Credit notes (revenue and VAT back, against the clearing account their settlement uses) and
-- bill payments (owed to suppliers less, out of the bank).
create or replace view ledger_detail as
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

create trigger bill_payments_books_changed after insert or update or delete or truncate on bill_payments
  for each statement execute function books_changed();
