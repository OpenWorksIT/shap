-- Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): what a
-- practice agrees with each client, and its own working papers for each client's year. The
-- practice's own records about its clients, like practice_clients: in its database, never in a
-- client's books. (Every database gets them; only a practice's has rows.)

-- An engagement letter: drafted from the client's details (lib/engagement.ts), changed as the
-- practice likes while it's a draft, then sent, accepted by the client, and in time ended (or
-- replaced by a newer one). Its text is kept as it was sent.
create table if not exists practice_letters (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references practice_clients(id) on delete cascade,
  services text[] not null check (cardinality(services) between 0 and 6),
  other text not null default '' check (length(other) <= 2000),
  -- The first year it's for (the year end), and every later one until it ends.
  from_year_end date not null,
  body jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'ended')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by uuid references users(id),
  -- How the client accepted it: a signed copy (kept here, with the letter: not among the practice's
  -- own attachments, which a wipe of its books takes), or recorded.
  accepted_on date,
  accepted_name text check (accepted_name is null or length(accepted_name) between 1 and 200),
  accepted_capacity text check (accepted_capacity is null or length(accepted_capacity) <= 200),
  accepted_how text check (accepted_how is null or accepted_how in ('signed', 'recorded')),
  signed_name text check (signed_name is null or length(signed_name) between 1 and 200),
  signed_mime text check (signed_mime is null or signed_mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  signed_bytes bytea,
  accepted_by uuid references users(id),
  ended_at timestamptz,
  ended_by uuid references users(id),
  check (status <> 'accepted' or (accepted_on is not null and accepted_name is not null and accepted_how is not null)),
  check (accepted_how is distinct from 'signed' or (signed_bytes is not null and signed_mime is not null and signed_name is not null))
);
create index if not exists practice_letters_client on practice_letters (client_id, created_at);

-- A recurring engagement: the terms looked at again for a later year, and still fitting (ISRS 4410
-- (Revised) para 26). Who did, and when.
create table if not exists practice_letter_years (
  letter_id uuid not null references practice_letters(id) on delete cascade,
  fy_end date not null,
  confirmed_by uuid references users(id),
  confirmed_at timestamptz not null default now(),
  primary key (letter_id, fy_end)
);

-- The year's working papers: who prepared, reviewed and, as engagement partner, signed off the
-- year, and the books' trial balance as it was then (to say when it has changed since).
create table if not exists practice_signoffs (
  client_id uuid not null references practice_clients(id) on delete cascade,
  fy_end date not null,
  role text not null check (role in ('prepared', 'reviewed', 'partner')),
  user_id uuid not null references users(id),
  at timestamptz not null default now(),
  tb_hash text,
  primary key (client_id, fy_end, role)
);

-- An account's balance at the year end ticked as prepared or reviewed (a client whose books are on
-- this server), with the balance it had then.
create table if not exists practice_ticks (
  client_id uuid not null references practice_clients(id) on delete cascade,
  fy_end date not null,
  account_code text not null check (length(account_code) between 1 and 40),
  account_name text not null check (length(account_name) between 1 and 200),
  prepared_by uuid references users(id),
  prepared_at timestamptz,
  prepared_cents bigint,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  reviewed_cents bigint,
  primary key (client_id, fy_end, account_code)
);

-- A review note on the year (or one of its accounts), its replies, and who cleared it.
create table if not exists practice_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references practice_clients(id) on delete cascade,
  fy_end date not null,
  account_code text check (account_code is null or length(account_code) between 1 and 40),
  account_name text check (account_name is null or length(account_name) between 1 and 200),
  text text not null check (length(text) between 1 and 4000),
  raised_by uuid not null references users(id),
  raised_at timestamptz not null default now(),
  cleared_by uuid references users(id),
  cleared_at timestamptz
);
create index if not exists practice_notes_year on practice_notes (client_id, fy_end);
create table if not exists practice_note_replies (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references practice_notes(id) on delete cascade,
  text text not null check (length(text) between 1 and 4000),
  by_user uuid not null references users(id),
  at timestamptz not null default now()
);
