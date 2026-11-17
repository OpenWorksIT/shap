-- Shap Accountant, a client on its own Shap (docs/ACCOUNTANT.md): its owner links their accountant's
-- practice (Settings → People → Your accountant), and the practice's people open the books here,
-- each time with a sign-in that works once. Every database gets these tables; a business's own Shap
-- uses the first three, a practice's the last columns.

-- The links this Shap's owner made: one code each until the practice uses it (a week), then what the
-- practice's server shows every time it asks for something (its credential, kept as a hash only).
create table if not exists accountant_links (
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('books', 'compile')),
  code_hash text unique,
  code_expires_at timestamptz,
  credential_hash text unique,
  practice_name text check (practice_name is null or length(practice_name) between 1 and 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  linked_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users(id),
  check (revoked_at is not null or credential_hash is not null or code_hash is not null)
);

-- Someone from that practice, in these books as who they are there, never by password: one row each
-- (the practice's own id for them), made the first time they open the books from it.
alter table users add column if not exists link_id uuid references accountant_links(id);
alter table users add column if not exists link_person uuid;
create unique index if not exists users_link_person on users(link_id, link_person) where link_id is not null;

-- A sign-in made for one of them: it works once, within a minute (LINK_SIGN_IN_SECONDS).
create table if not exists link_entries (
  token_hash text primary key,
  link_id uuid not null references accountant_links(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- A practice's client on its own Shap: its address, the credential sealed (lib/crypto.ts), and what
-- the client lets the practice do there.
alter table practice_clients add column if not exists link_url text check (link_url is null or link_url ~ '^https?://');
alter table practice_clients add column if not exists link_credential text;
alter table practice_clients add column if not exists link_level text check (link_level is null or link_level in ('books', 'compile'));
