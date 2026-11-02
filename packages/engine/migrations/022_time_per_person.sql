-- The time tracker's clock is per person: on a shared server each person runs their own.
alter table time_entries add column user_id uuid references users(id) on delete set null;
drop index time_entries_running;
create unique index time_entries_running on time_entries (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) where ended_at is null;
