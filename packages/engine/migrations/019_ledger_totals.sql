-- Faster reports on big books.
--
-- 1. The system-account lookup is fixed once the books exist, so it's marked immutable: the
--    planner works each one out once per query instead of once per ledger row (about twice as
--    fast on ten years of a busy business's books).
create or replace function sys_account(key text) returns uuid language sql immutable as $$
  select id from accounts where system_key = key
$$;

-- 2. Totals per account, day and source, kept beside the ledger. Reports that only need sums
--    (trial balance, income statement, balance sheet, Home, VAT and tax) read these instead of
--    working the whole ledger out again. Any change to the books marks them out of date, and the
--    next report rebuilds them once.
create table books_version (
  id boolean primary key default true check (id),
  changed bigint not null default 1,
  totals bigint not null default 0
);
insert into books_version default values;

create table ledger_totals (
  account_id uuid not null,
  date date not null,
  source text not null,
  amount_cents bigint not null,
  postings int not null
);
create index ledger_totals_account_date on ledger_totals (account_id, date);
create index ledger_totals_date on ledger_totals (date);

create function books_changed() returns trigger language plpgsql as $$
begin
  update books_version set changed = changed + 1;
  return null;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['documents', 'document_lines', 'receipts', 'costs', 'labour_entries', 'wage_payments',
                           'journals', 'journal_lines', 'assets', 'year_end_figures', 'projects', 'payment_sources',
                           'cost_categories', 'accounts']
  loop
    execute format('create trigger %I after insert or update or delete or truncate on %I for each statement execute function books_changed()',
                   t || '_books_changed', t);
  end loop;
end
$$;

-- Rebuilds the totals if anything changed since they were last worked out. Cheap when nothing did.
create function fresh_ledger_totals() returns void language plpgsql as $$
declare v bigint;
begin
  if exists (select 1 from books_version where totals = changed) then
    return;
  end if;
  perform pg_advisory_xact_lock(4201);
  select changed into v from books_version;
  if exists (select 1 from books_version where totals = v) then
    return;
  end if;
  delete from ledger_totals;
  insert into ledger_totals (account_id, date, source, amount_cents, postings)
    select account_id, date, source, sum(amount_cents)::bigint, count(*)::int from ledger group by 1, 2, 3;
  update books_version set totals = v;
end
$$;
