-- More kinds of business (packages/shared/src/entities.ts): partnerships, (Pty) Ltd, Inc.,
-- close corporations, trading trusts, non-profit companies and co-operatives, as well as sole
-- proprietors. 'company' stays the private company ((Pty) Ltd).
alter table settings drop constraint if exists settings_business_type_check;
alter table settings add constraint settings_business_type_check
  check (business_type in ('sole_prop', 'partnership', 'company', 'inc', 'cc', 'trust', 'npc', 'coop'));
-- A non-profit company approved by SARS as a public benefit organisation.
alter table settings add column if not exists approved_pbo boolean not null default false;

-- A partnership's partners: each has a capital account (what they put in) and a current account
-- (their share of profit, less what they've taken out), and a share of profit and loss.
create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  share_bp integer not null check (share_bp between 0 and 10000),
  capital_account_id uuid not null references accounts(id),
  current_account_id uuid not null references accounts(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- A year's profit (or loss) shared between the partners: one journal at the year end, moving it
-- out of "Profit not yet shared" into their current accounts. Shared again, it's replaced.
alter table journals drop constraint journals_kind_check;
alter table journals add constraint journals_kind_check
  check (kind in ('manual', 'opening', 'import', 'adjustment', 'payroll', 'dividend', 'sars', 'profit_share'));
create table if not exists profit_shares (
  fy_end date primary key,
  journal_id uuid not null references journals(id) on delete cascade,
  profit_cents bigint not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- A trust's distribution only comes off the trust's taxable income when it's this year's income
-- given to a beneficiary who is a South African resident (section 25B): non-residents' income is
-- taxed in the trust, and capital or earlier years' income doesn't count.
alter table dividends add column if not exists conduit boolean not null default true;

-- The shares each year's profit was split by (they can change later, partners can leave).
alter table profit_shares add column if not exists shares jsonb not null default '[]';
