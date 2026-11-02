-- Usual items brought in from another package (its products and services list): offered
-- alongside what's been charged before when adding a line.
create table items (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  category text not null default 'labour',
  unit text not null default '',
  unit_price_cents bigint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index items_description on items ((lower(description)));
