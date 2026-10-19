-- Bank and card statements, imported from CSV and reconciled against what's captured.
-- SPDX-License-Identifier: AGPL-3.0-or-later

create table bank_statements (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references payment_sources(id),
  filename text not null default '',
  from_date date,
  to_date date,
  closing_balance_cents bigint,
  line_count int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- One transaction on a statement. Money in is positive, money out negative.
create table bank_lines (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references bank_statements(id) on delete cascade,
  source_id uuid not null references payment_sources(id),
  date date not null,
  description text not null,
  amount_cents bigint not null check (amount_cents <> 0),
  balance_cents bigint,
  -- The same transaction on an overlapping statement is recognised and skipped.
  fingerprint text not null,
  -- Left off on purpose (personal spending on a card, a transfer you don't want to capture…).
  ignored boolean not null default false,
  created_at timestamptz not null default now(),
  unique (source_id, fingerprint)
);
create index bank_lines_source_date on bank_lines(source_id, date);

-- What a statement line is: one or more captured costs (a slip broken into items), a payment
-- received, a wage payment or a journal (transfers). Each record belongs to one statement line.
create table bank_matches (
  id uuid primary key default gen_random_uuid(),
  bank_line_id uuid not null references bank_lines(id) on delete cascade,
  kind text not null check (kind in ('cost', 'receipt', 'wage_payment', 'journal')),
  record_id uuid not null,
  unique (kind, record_id)
);
create index bank_matches_line on bank_matches(bank_line_id);
