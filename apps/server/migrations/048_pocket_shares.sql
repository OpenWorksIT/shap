-- A Shap Pocket share (docs/ACCOUNTANT.md, "A Shap Pocket share"): the whole of a one-person
-- business's books from their phone, brought into a practice's client's books as a read-only copy.
-- Each share brought in, with its stamp and what changed since the last one.
create table if not exists pocket_shares (
  number int primary key check (number > 0),
  made_at text not null default '',
  through date not null,
  previous_number int,
  changes jsonb not null default '{}',
  filename text not null default '',
  imported_by uuid references users(id),
  imported_at timestamptz not null default now()
);
-- Each entry the shares brought in, by its key in Pocket, and the journal it is here.
create table if not exists pocket_share_entries (
  key text primary key,
  hash text not null,
  date date not null,
  description text not null default '',
  cents bigint not null default 0,
  journal_id uuid not null references journals(id) on delete cascade
);
-- Which of these books' accounts each of Pocket's account codes went to.
create table if not exists pocket_share_accounts (
  pocket_code text primary key,
  account_id uuid not null references accounts(id)
);
