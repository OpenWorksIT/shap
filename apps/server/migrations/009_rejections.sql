-- Suggestions you've said are wrong stay gone: a pair of costs that aren't the same purchase,
-- or a match suggested for a statement line. They can be brought back.
-- SPDX-License-Identifier: AGPL-3.0-or-later
create table rejected_suggestions (
  id uuid primary key default gen_random_uuid(),
  -- 'duplicate': two costs that aren't the same purchase; 'bank': a match suggested for a statement line.
  kind text not null check (kind in ('duplicate', 'bank')),
  -- duplicate: the cost it suggested removing. bank: the statement line.
  subject uuid not null,
  -- duplicate: the cost it suggested keeping ('' if none). bank: what it suggested ("cost:<id>,<id>").
  target text not null,
  user_id uuid references users(id),
  at timestamptz not null default now(),
  unique (kind, subject, target)
);

-- A statement whose transactions are also on another account, looked at and fine (transfers).
alter table bank_statements add column elsewhere_ok boolean not null default false;
