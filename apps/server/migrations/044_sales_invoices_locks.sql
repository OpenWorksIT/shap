-- Every sale is an invoice, and the books lock month by month (1.24).

-- ---------------------------------------------------------------- sales are invoices
-- A sale at the counter is an invoice, issued and paid on the spot, numbered in the invoice series
-- (docs/SALES_AND_STOCK.md). A walk-in's needs no client: it's the abridged tax invoice, up to
-- R5 000. "Sold at the counter" is what sets it apart from an invoice from Quotes & invoices.
alter table documents add column if not exists counter boolean not null default false;
update documents set counter = true where sale_number is not null;

-- Sales made before were documents of their own kind, numbered in their own series (SL00001…):
-- invoices now, keeping the number each was issued under (it's what the customer holds, and the
-- record SARS sees has to match it). One whose number an invoice already has (only if the invoice
-- numbers were set up the same as the sales') keeps it with "-S" after it.
update documents d set
  kind = 'invoice',
  due_date = coalesce(d.due_date, d.issue_date),
  number = case when exists (select 1 from documents i where i.kind = 'invoice' and i.number = d.number) then d.number || '-S' else d.number end,
  sale_number = null,
  updated_at = now()
where d.kind = 'sale';

alter table documents drop constraint if exists documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('quote', 'invoice', 'credit_note'));
alter table documents drop constraint if exists documents_check;
alter table documents add constraint documents_check check (
  (kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
  or (kind in ('invoice', 'credit_note') and status in ('draft', 'issued', 'void')));
alter table documents drop constraint if exists documents_counter_check;
alter table documents add constraint documents_counter_check check (not counter or kind = 'invoice');
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
