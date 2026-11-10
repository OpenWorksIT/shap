-- Who may do what (packages/shared/src/access.ts, docs/PEOPLE.md). Besides the owner and the
-- accountant, everyone who signs in is staff: they do the tasks ticked for them, from a named
-- profile (Teller, Admin, Site staff…) with anything changed for that person on top. Changing a
-- profile changes it for everyone on it, except what was changed for them: so a person keeps
-- only what differs from their profile (ticked extra, or taken away).
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  access text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_name on profiles (lower(name));

alter table users add column if not exists profile_id uuid references profiles(id);
alter table users add column if not exists access_add text[] not null default '{}';
alter table users add column if not exists access_remove text[] not null default '{}';

-- The profiles a business starts with: each can be changed, renamed or removed.
insert into profiles (name, access) values
  ('Teller', '{sales.sell,stock.view}'),
  ('Admin', '{documents.view,documents.edit,documents.paid,clients.edit,costs.view,costs.manage,bills.pay,stock.view,stock.costs,stock.buy,reports.view,bank.reconcile,sales.view,labour.view}'),
  ('Site staff', '{labour.log,costs.capture,jobs.view}')
on conflict do nothing;

-- Site capture becomes staff on the Site staff profile: the same as before (log days and slips,
-- see the jobs, no money).
alter table users drop constraint if exists users_role_check;
update users set role = 'staff', profile_id = (select id from profiles where name = 'Site staff') where role = 'capture';
alter table users add constraint users_role_check check (role in ('owner', 'staff', 'accountant'));
-- Only staff are on a profile or have tasks of their own.
alter table users drop constraint if exists users_staff_access;
alter table users add constraint users_staff_access check (role = 'staff' or (profile_id is null and access_add = '{}' and access_remove = '{}'));
