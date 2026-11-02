-- Payroll (employees on a salary) and dividends to shareholders. Both post to the books as
-- journals the app makes (kind 'payroll', 'dividend', 'sars'), linked back by source_id, so the
-- ledger needs nothing new and a draft can be reopened by deleting its journal.

alter table journals drop constraint journals_kind_check;
alter table journals add constraint journals_kind_check check (kind in ('manual', 'opening', 'import', 'adjustment', 'payroll', 'dividend', 'sars'));
alter table journals add column source_id uuid;
create index journals_source on journals(source_id) where source_id is not null;

insert into accounts (code, name, type, system_key) values
  ('2600', 'PAYE owed (SARS)', 'liability', 'paye_payable'),
  ('2610', 'UIF owed', 'liability', 'uif_payable'),
  ('2620', 'SDL owed (SARS)', 'liability', 'sdl_payable'),
  ('2700', 'Dividends tax owed (SARS)', 'liability', 'dwt_payable'),
  ('2710', 'Dividends owed to shareholders', 'liability', 'dividends_payable'),
  ('3200', 'Dividends declared', 'equity', 'dividends'),
  ('6165', 'Salaries (employees)', 'expense', 'salaries'),
  ('6166', 'UIF and SDL (employer)', 'expense', 'payroll_levies')
on conflict do nothing;

create table employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  id_number text not null default '',
  tax_number text not null default '',
  is_director boolean not null default false,
  salary_cents bigint not null default 0 check (salary_cents >= 0),
  age_band text not null default 'under65' check (age_band in ('under65', '65to74', '75plus')),
  medical_members int not null default 0 check (medical_members >= 0),
  uif boolean not null default true,
  start_date date not null,
  end_date date,
  bank_details text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table pay_runs (
  id uuid primary key default gen_random_uuid(),
  period text not null unique check (period ~ '^\d{4}-\d{2}$'),
  pay_date date not null,
  source_id uuid not null references payment_sources(id),
  status text not null default 'draft' check (status in ('draft', 'final')),
  journal_id uuid references journals(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table pay_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references pay_runs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  is_director boolean not null default false,
  salary_cents bigint not null default 0,
  extra_cents bigint not null default 0,
  gross_cents bigint not null default 0,
  paye_cents bigint not null default 0,
  uif_employee_cents bigint not null default 0,
  uif_employer_cents bigint not null default 0,
  sdl_cents bigint not null default 0,
  net_cents bigint not null default 0,
  note text not null default '',
  unique (run_id, employee_id)
);

create table dividends (
  id uuid primary key default gen_random_uuid(),
  declared_on date not null,
  paid_on date,
  shareholder text not null,
  gross_cents bigint not null check (gross_cents > 0),
  exempt boolean not null default false,
  dwt_cents bigint not null default 0,
  net_cents bigint not null default 0,
  source_id uuid references payment_sources(id),
  note text not null default '',
  journal_id uuid references journals(id) on delete set null,
  paid_journal_id uuid references journals(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Money paid to SARS for a month's PAYE/UIF/SDL (EMP201) or dividends tax.
create table sars_payments (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('emp201', 'dwt')),
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  source_id uuid not null references payment_sources(id),
  reference text not null default '',
  journal_id uuid references journals(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
