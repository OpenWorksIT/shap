-- Shap Accountant, phase 5 (docs/ACCOUNTANT.md, "Engagement letters and working papers"): what a
-- practice agrees with each client, and its own working papers for each client's year. The
-- practice's own records about its clients, like practice_clients: in its database, never in a
-- client's books. (Every database gets them; only a practice's has rows.)

-- An engagement letter: drafted from the client's details (lib/engagement.ts), changed as the
-- practice likes while it's a draft, then sent, accepted by the client, and in time ended (or
-- replaced by a newer one). Its text, and its parties, are kept as they were sent.
create table if not exists practice_letters (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references practice_clients(id) on delete cascade,
  services text[] not null check (cardinality(services) between 0 and 6),
  other text not null default '' check (length(other) <= 2000),
  -- The first year it's for (the year end), and every later one until it ends.
  from_year_end date not null,
  body jsonb not null,
  -- The parties, as the letter names them: the practice's legal name, registration number, trading
  -- name and address, and the client's name. From Settings and the client's books when it's drafted;
  -- changed with the draft; kept as they are once it's sent (whatever is renamed later).
  practice_name text not null check (length(practice_name) between 1 and 200),
  practice_reg text not null default '' check (length(practice_reg) <= 60),
  practice_trading text not null default '' check (length(practice_trading) <= 200),
  practice_address text not null default '' check (length(practice_address) <= 500),
  client_name text not null check (length(client_name) between 1 and 200),
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
  -- Ended: the last year end it covers (none, if it ended before its first).
  last_year_end date,
  check (status <> 'accepted' or (accepted_on is not null and accepted_name is not null and accepted_how is not null)),
  check (accepted_how is distinct from 'signed' or (signed_bytes is not null and signed_mime is not null and signed_name is not null)),
  check (last_year_end is null or (status = 'ended' and last_year_end >= from_year_end))
);
create index if not exists practice_letters_client on practice_letters (client_id, created_at);

-- What's sent is kept: once a letter isn't a draft its words, its parties and what it's for don't
-- change, an acceptance once recorded doesn't, it only moves on (sent, accepted, ended), and it isn't
-- deleted (but with its client, which a practice only does to a client it has just failed to add).
-- The routes ask for the status they expect too; this holds whatever runs alongside them.
create or replace function practice_letter_kept() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and pg_trigger_depth() <= 1 then
      raise exception 'A letter that has been sent is kept: end it instead' using errcode = 'SH001';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (new.body is distinct from old.body or new.services is distinct from old.services or new.other is distinct from old.other
      or new.from_year_end is distinct from old.from_year_end or new.client_id is distinct from old.client_id
      or new.practice_name is distinct from old.practice_name or new.practice_reg is distinct from old.practice_reg
      or new.practice_trading is distinct from old.practice_trading or new.practice_address is distinct from old.practice_address
      or new.client_name is distinct from old.client_name or new.sent_at is distinct from old.sent_at or new.sent_by is distinct from old.sent_by) then
    raise exception 'A sent letter''s words are kept as they are: make a new letter to change them' using errcode = 'SH001';
  end if;
  if old.status in ('accepted', 'ended') and (new.accepted_on is distinct from old.accepted_on or new.accepted_name is distinct from old.accepted_name
      or new.accepted_capacity is distinct from old.accepted_capacity or new.accepted_how is distinct from old.accepted_how
      or new.accepted_by is distinct from old.accepted_by or new.signed_name is distinct from old.signed_name
      or new.signed_mime is distinct from old.signed_mime or new.signed_bytes is distinct from old.signed_bytes) then
    raise exception 'A letter''s acceptance is kept as it was recorded' using errcode = 'SH001';
  end if;
  if old.status = 'ended' and (new.status <> 'ended' or new.last_year_end is distinct from old.last_year_end or new.ended_at is distinct from old.ended_at or new.ended_by is distinct from old.ended_by) then
    raise exception 'An ended letter is kept as it ended' using errcode = 'SH001';
  end if;
  if not (new.status = old.status or (old.status, new.status) in (('draft', 'sent'), ('sent', 'accepted'), ('sent', 'ended'), ('accepted', 'ended'))) then
    raise exception 'A letter only moves on: drafted, sent, accepted, ended' using errcode = 'SH001';
  end if;
  return new;
end $$;
drop trigger if exists practice_letters_kept on practice_letters;
create trigger practice_letters_kept before update or delete on practice_letters for each row execute function practice_letter_kept();

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
-- year, and the books' trial balance as it was then (its rows, and their fingerprint, to say when it
-- has changed since). A client on its own Shap has no trial balance here: neither is kept.
create table if not exists practice_signoffs (
  client_id uuid not null references practice_clients(id) on delete cascade,
  fy_end date not null,
  role text not null check (role in ('prepared', 'reviewed', 'partner')),
  user_id uuid not null references users(id),
  at timestamptz not null default now(),
  tb_hash text,
  tb jsonb,
  primary key (client_id, fy_end, role)
);

-- An account's balance at the year end ticked as prepared or reviewed (a client whose books are on
-- this server), with the balance and kind of account it had then. By the account itself (its id in the client's books),
-- so a new code, or a code another account takes later, doesn't move a tick; the code and name are
-- kept to show it by.
create table if not exists practice_ticks (
  client_id uuid not null references practice_clients(id) on delete cascade,
  fy_end date not null,
  account_id uuid not null,
  account_code text not null check (length(account_code) between 1 and 40),
  account_name text not null check (length(account_name) between 1 and 200),
  prepared_by uuid references users(id),
  prepared_at timestamptz,
  prepared_cents bigint,
  prepared_type text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  reviewed_cents bigint,
  reviewed_type text,
  primary key (client_id, fy_end, account_id)
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
