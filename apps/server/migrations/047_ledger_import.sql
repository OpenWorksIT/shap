-- Another package's books (Shap Accountant phase 2, docs/ACCOUNTANT.md): which of these books'
-- accounts each of the package's accounts goes to, remembered so the next period's files map by
-- themselves. Keyed by the package's code and name as its files write them.
create table if not exists ledger_import_accounts (
  source_code text not null default '',
  source_name text not null,
  account_id uuid not null references accounts(id),
  updated_at timestamptz not null default now(),
  primary key (source_code, source_name)
);

-- Each file brought in, for the list and to bring the same period in again (it replaces the last).
create table if not exists ledger_imports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('trialBalance', 'ledger')),
  source text not null default '',
  filename text not null default '',
  -- A trial balance's date; a ledger's first and last day.
  date_from date not null,
  date_to date not null,
  lines int not null default 0,
  -- SHA-256 of the file as brought in: which export the figures came from.
  file_hash text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
alter table journals add column if not exists ledger_import_id uuid references ledger_imports(id) on delete cascade;
create index if not exists journals_ledger_import on journals(ledger_import_id) where ledger_import_id is not null;
