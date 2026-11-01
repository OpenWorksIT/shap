-- Costs merged as counted twice can be put back, and statement lines are compared across
-- accounts so a file imported under the wrong account is caught.
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- One row per merge: enough to undo it exactly.
create table cost_merges (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  user_id uuid references users(id),
  -- No cost kept when the removed one was a statement line imported twice, already paid for by something else.
  kept_id uuid,
  -- The cost removed, as it was (every column).
  removed jsonb not null,
  -- The kept cost's columns before the merge.
  kept_before jsonb,
  -- The removed cost's ties to statement lines, and statement lines deleted as imported twice.
  matches jsonb not null default '[]',
  lines jsonb not null default '[]',
  undone_at timestamptz
);
create index cost_merges_at on cost_merges(at desc);

-- The same transaction: same date, amount and description (letters and digits only).
create index if not exists bank_lines_same on bank_lines(date, amount_cents);

-- Matching a cost to a statement line says which account paid it (and may round it to the
-- statement's amount). What it was before is kept, so unmatching or deleting the statement
-- puts it back.
alter table bank_matches add column source_changed boolean not null default false;
alter table bank_matches add column prev_source_id uuid references payment_sources(id) on delete set null;
alter table bank_matches add column prev_amount_cents bigint;
alter table bank_matches add column prev_note text;
