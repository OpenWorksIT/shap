-- A Shap Pocket share (docs/ACCOUNTANT.md, "A Shap Pocket share"): a one-person business's books
-- from their phone, brought into the practice's copy of them (a client of kind 'pocket'). The
-- share's records replace the copy's each time (import/pocket-share.ts); this keeps each share
-- brought in: its stamp, these books' id (a share of other books is refused), the file's
-- SHA-256, and how many entries it added, changed and took out (counts only: no descriptions).
create table if not exists pocket_shares (
  id uuid primary key default gen_random_uuid(),
  number int not null check (number > 0),
  made_at timestamptz not null,
  through date not null,
  previous_number int,
  books_id uuid not null,
  file_hash text not null,
  -- The phone's books were restored or begun again: a lower number, made later.
  restored boolean not null default false,
  changes jsonb not null default '{}',
  filename text not null default '',
  imported_by uuid references users(id),
  imported_at timestamptz not null default now()
);
create index if not exists pocket_shares_number on pocket_shares (number);
