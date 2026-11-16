-- Shap Accountant (docs/ACCOUNTANT.md): this server keeps and checks clients' books, each client in
-- a database of its own next to this one. These tables are the practice layer: which clients there
-- are, who in the practice may open which, and what each client's checks last found. They hold no
-- books. (Every database gets them, as it gets every migration; only the practice's has rows.)
create table if not exists practice_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  -- kept: the practice writes the books up here; imported: brought in from the package the client
  -- keeps them in (Accounts → From another package). (Pocket and linked clients are planned.)
  kind text not null default 'kept' check (kind in ('kept', 'imported', 'pocket', 'linked')),
  -- The client's own database, on this server: <this database>__c_<12 hex>.
  db_name text unique check (db_name ~ '^[a-z0-9_]{1,63}$'),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  -- What the checks found when they last ran (practice.ts healthOf), and when they started.
  health jsonb,
  health_at timestamptz,
  -- Its migrations didn't all run at the last start (main.ts): it isn't opened until they do.
  migrate_error text
);

-- Who in the practice may open a client, and how: 'books' writes them up (the client's owner, in
-- its own database), 'compile' reads them and compiles the statements (its accountant). The
-- practice's owner opens every client, either way.
create table if not exists practice_access (
  client_id uuid not null references practice_clients(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  level text not null check (level in ('books', 'compile')),
  primary key (client_id, user_id)
);

-- In a client's books the practice records the directors' approval of the statements rather than
-- giving it (Companies Act s30(3)(c)): the page a director signed, kept with the approved set.
alter table financial_statements add column if not exists approval_signed_id uuid references attachments(id);
