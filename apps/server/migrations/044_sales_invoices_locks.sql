-- Every sale is an invoice, and the books lock month by month (1.24).

-- ---------------------------------------------------------------- sales are invoices
-- A sale at the counter is an invoice, issued and paid on the spot, numbered in the invoice series
-- (docs/SALES_AND_STOCK.md). A walk-in's needs no client: it's the abridged tax invoice, up to
-- R5 000. "Sold at the counter" is what sets it apart from an invoice from Quotes & invoices.
alter table documents add column if not exists counter boolean not null default false;
update documents set counter = true where sale_number is not null;

-- Sales made before were documents of their own kind, numbered in their own series (SL00001…), on
-- a slip: invoices now, each keeping the number it was issued under (the customer holds it, and the
-- record SARS sees has to match), its date, amounts, terms and (no) due date; legacy_sale reprints
-- it as it was handed over (its heading and "Sale no."). Where an invoice already has that number
-- (only if the invoice numbers were set up the same as the sales'): a draft takes "-D" (a draft was
-- never handed to anyone); an issued one keeps it, and the sale takes "-S" with the number it was
-- issued under kept as its sale number, printed on it. Each renumbering is in the audit log.
alter table documents add column if not exists legacy_sale boolean not null default false;
with clash as (
  update documents i set number = i.number || '-D', updated_at = now()
  from documents s where s.kind = 'sale' and i.kind = 'invoice' and i.status = 'draft' and i.number = s.number
  returning i.id, s.number as was
)
insert into audit_log (actor, action, entity, entity_id, details)
select 'system', 'renumber', 'invoice', id::text, jsonb_build_object('from', was, 'to', was || '-D', 'why', 'a sale from before 1.24 has this number: the draft takes another') from clash;
with clash as (
  update documents d set number = d.number || '-S', sale_number = d.number
  where d.kind = 'sale' and exists (select 1 from documents i where i.kind = 'invoice' and i.number = d.number)
  returning d.id, d.sale_number as was
)
insert into audit_log (actor, action, entity, entity_id, details)
select 'system', 'renumber', 'invoice', id::text, jsonb_build_object('from', was, 'to', was || '-S', 'why', 'an invoice was issued with this number before 1.24 (the sales'' numbers were their own): the sale keeps it as its sale number') from clash;
update documents d set kind = 'invoice', legacy_sale = true, sale_number = case when d.number = d.sale_number then null else d.sale_number end, updated_at = now()
where d.kind = 'sale';

alter table documents drop constraint if exists documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('quote', 'invoice', 'credit_note'));
alter table documents drop constraint if exists documents_check;
alter table documents add constraint documents_check check (
  (kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
  or (kind in ('invoice', 'credit_note') and status in ('draft', 'issued', 'void')));
-- A sale's invoice is always issued (never a draft, never voided: money back is a refund). Not
-- checked against what's there already (the books audit says if anything isn't).
alter table documents drop constraint if exists documents_counter_check;
alter table documents add constraint documents_counter_check check (not counter or (kind = 'invoice' and status = 'issued')) not valid;
comment on column documents.sale_number is 'Before 1.24 only: the sale number an invoice made from a sale was first issued under (printed as "Sale no.")';

-- The sales' own number series is gone.
alter table settings drop column if exists sale_prefix;
alter table settings drop column if exists sale_next;
alter table settings drop column if exists sale_pad;

-- ---------------------------------------------------------------- locks
-- Everything dated on or before the lock date is closed, for everyone: someone who may close and
-- reopen periods (the "books.lock" task) reopens it with a reason, puts it right and locks it again.
-- relock_date: the lock date before it was reopened, to lock it again at.
alter table settings add column if not exists relock_date date;
-- A business that sells closes each month (month end): by hand, or the month locks itself on a day
-- of the next month. month_locked_through: the last month end it locked by itself (so a month
-- reopened isn't locked again until the next one's day).
alter table settings add column if not exists month_end_mode text not null default 'manual';
alter table settings drop constraint if exists settings_month_end_mode_check;
alter table settings add constraint settings_month_end_mode_check check (month_end_mode in ('manual', 'auto'));
alter table settings add column if not exists month_end_day int not null default 7;
alter table settings drop constraint if exists settings_month_end_day_check;
alter table settings add constraint settings_month_end_day_check check (month_end_day between 1 and 28);
alter table settings add column if not exists month_locked_through date;

-- ---------------------------------------------------------------- signed statements kept
-- Reopening approved financial statements takes them back to a draft; the set that was signed is
-- kept as it was (Companies Act s24: seven years), with its signed PDF and the reason it was reopened.
create table if not exists financial_statement_versions (
  id uuid primary key default gen_random_uuid(),
  fy_end date not null,
  -- The statements' row as it was (status, the signed snapshot, compiler, approval, the PDFs).
  signed jsonb not null,
  final_pdf_id uuid references attachments(id) on delete restrict,
  compiler_report_id uuid references attachments(id) on delete restrict,
  reopened_at timestamptz not null default now(),
  reopened_by uuid references users(id) on delete set null,
  reason text not null default ''
);
create index if not exists financial_statement_versions_fy on financial_statement_versions (fy_end, reopened_at);
