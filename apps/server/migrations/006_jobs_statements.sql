-- Parts that aren't for a job on purpose, bank statement PDFs on file, bonuses for workers,
-- and jobs that close once they're paid.
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A materials cost with no job is flagged until it's given one, or marked as not for a job.
alter table costs add column no_job boolean not null default false;

-- Accounts whose monthly statement should be kept on file (and since when).
alter table payment_sources
  add column statements_required boolean not null default false,
  add column statements_from date;

-- The bank's own statement (PDF) for a month, for your records and the accountant.
create table statement_files (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references payment_sources(id),
  month date not null check (extract(day from month) = 1),
  attachment_id uuid not null references attachments(id),
  filename text not null default '',
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index statement_files_source on statement_files(source_id, month);

-- Money paid to a worker that wasn't for days worked: a bonus, an extra.
insert into work_types (name, sort) values ('Bonuses & extras', 50) on conflict (name) do nothing;

-- Jobs whose invoices are all settled (paid or written off) and that are fully invoiced
-- (at least the accepted quotes) are done; fully invoiced but still owing: invoiced.
with inv as (
  select d.project_id,
    sum(d.total_cents) as invoiced,
    bool_and(d.written_off_on is not null or coalesce((select sum(r.amount_cents) from receipts r where r.invoice_id = d.id), 0) >= d.total_cents) as settled
  from documents d where d.kind = 'invoice' and d.status = 'issued' and d.project_id is not null group by d.project_id
), quoted as (
  select project_id, sum(total_cents) as quoted from documents where kind = 'quote' and status = 'accepted' and project_id is not null group by project_id
)
update projects p set status = case when inv.settled then 'done' else 'invoiced' end
from inv left join quoted q on q.project_id = inv.project_id
where p.id = inv.project_id and p.status in ('active', 'invoiced')
  and inv.invoiced >= coalesce(q.quoted, 0);
