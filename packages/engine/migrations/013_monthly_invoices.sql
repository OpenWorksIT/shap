-- Monthly invoices: an invoice that goes out again every month (hosting, maintenance, a
-- retainer). Each month's copy is a normal invoice, linked back to its schedule.
-- SPDX-License-Identifier: AGPL-3.0-or-later
create table monthly_invoices (
  id uuid primary key default gen_random_uuid(),
  -- The invoice each month's is copied from: the latest one in the series (starts as the one you
  -- made monthly), so a change carries on to the following months.
  source_id uuid not null references documents(id),
  -- The day of the month it goes out (the 31st becomes the month's last day).
  day_of_month int not null check (day_of_month between 1 and 31),
  starts_on date not null,
  ends_on date,
  -- 'send': issued and emailed by itself. 'draft': made as a draft for you to check and send.
  mode text not null default 'send' check (mode in ('send', 'draft')),
  email_to text not null default '',
  message text not null default '',
  active boolean not null default true,
  -- The last thing that went wrong (an email that bounced, the books closed for that date).
  last_error text,
  last_error_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

alter table documents add column monthly_id uuid references monthly_invoices(id) on delete set null;
-- The month ('YYYY-MM') a monthly invoice is for: one per schedule per month, never two.
alter table documents add column monthly_period text;
create unique index documents_monthly_once on documents(monthly_id, monthly_period) where monthly_id is not null;
