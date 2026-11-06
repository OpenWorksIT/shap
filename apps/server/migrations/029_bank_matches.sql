-- Statement lines can be matched to more of what's already in the books:
--   * a payment made on a supplier bill (Bills), as itself, instead of the bill being taken for a
--     second, already-paid cost;
--   * a journal on that account (a transfer between two of your own accounts, net pay, SARS),
--     so the other side of a transfer is ticked off against the journal already there instead
--     of posting it twice.
-- A journal can now be matched once on each account's statement (a transfer touches two), so a
-- match remembers which account's statement it's on.
alter table bank_matches drop constraint if exists bank_matches_kind_check;
alter table bank_matches add constraint bank_matches_kind_check check (kind in ('cost', 'receipt', 'wage_payment', 'journal', 'bill_payment'));
alter table bank_matches add column if not exists source_id uuid;
update bank_matches m set source_id = l.source_id from bank_lines l where l.id = m.bank_line_id and m.source_id is null;

create or replace function bank_match_source() returns trigger language plpgsql as $$
begin
  if new.source_id is null then
    select source_id into new.source_id from bank_lines where id = new.bank_line_id;
  end if;
  return new;
end
$$;
drop trigger if exists bank_matches_source on bank_matches;
create trigger bank_matches_source before insert or update of bank_line_id on bank_matches
  for each row execute function bank_match_source();

alter table bank_matches alter column source_id set not null;
alter table bank_matches drop constraint if exists bank_matches_kind_record_id_key;
create unique index if not exists bank_matches_once on bank_matches (kind, record_id, source_id);
