-- Stock records and refunds are never changed or deleted (039): a correction is recorded instead.
-- The one exception is a Shap Pocket share brought into the practice's copy of a Pocket client's
-- books (import/pocket-share.ts): each share replaces the copy's records with the phone's, where
-- the same rule holds. That transaction says so with `set local shap.pocket_share = 'on'`, which
-- ends with it; nothing else in Shap sets it.
create or replace function stock_record_fixed() returns trigger language plpgsql as $$
begin
  if current_setting('shap.pocket_share', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'Stock records can''t be changed or deleted: record a correction instead' using errcode = 'P0001';
end $$;
