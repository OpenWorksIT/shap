-- Shap: jobs, labour, costs, quotes and invoices, and the books built from them.
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Money is integer cents (bigint). Dates are plain calendar dates.
-- Nothing posts to the ledger directly: the `ledger` view (002) reads it live from the
-- invoices, payments, costs, labour, wage payments, assets and journals below. Correct a
-- cost and the income statement, balance sheet and trial balance follow immediately.

-- ---------------------------------------------------------------- people who sign in
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('owner', 'capture', 'accountant')),
  active boolean not null default true,
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  totp_last_step bigint,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text not null default '',
  ip text not null default '',
  created_at timestamptz not null default now()
);
create index sessions_user on sessions(user_id);

create table recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz
);

-- Append-only: who changed what, when. Never rewritten.
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id),
  actor text not null default 'user',
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}',
  ip text not null default ''
);
create index audit_entity on audit_log(entity, entity_id);
create function audit_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- ---------------------------------------------------------------- chart of accounts
create table accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  type text not null check (type in ('asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense')),
  -- Accounts the app posts to by itself (receivables, wages owed, revenue by category…).
  system_key text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Where money came from or went to: the bank account, each card, cash, "I paid it myself".
create table payment_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check (kind in ('bank', 'card', 'cash', 'owner', 'other')),
  account_id uuid not null references accounts(id),
  active boolean not null default true,
  sort int not null default 0
);

-- What a cost was for (the tracker's "Type"), and which account it lands in.
create table cost_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check (kind in ('materials', 'demo', 'overhead', 'asset', 'personal')),
  account_id uuid not null references accounts(id),
  active boolean not null default true,
  sort int not null default 0
);

-- Labour that isn't for a job still has to go somewhere: yard, quoting, vehicle…
create table work_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0
);

-- ---------------------------------------------------------------- company settings (one row)
create table settings (
  id boolean primary key default true check (id),
  company_name text not null default 'My company',
  trading_name text not null default '',
  reg_number text not null default '',
  vat_number text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  bank_details text not null default '',
  logo_id uuid,
  vat_registered boolean not null default false,
  vat_rate_bp int not null default 1500,
  fy_end_month int not null default 2 check (fy_end_month between 1 and 12),
  invoice_prefix text not null default '',
  invoice_next int not null default 1,
  invoice_pad int not null default 0,
  quote_prefix text not null default 'Q',
  quote_next int not null default 1,
  quote_pad int not null default 4,
  payment_days int not null default 7,
  quote_valid_days int not null default 30,
  invoice_terms text not null default '',
  quote_terms text not null default '',
  markup_bp int not null default 0,
  default_receipt_source_id uuid references payment_sources(id),
  default_wage_source_id uuid references payment_sources(id),
  default_cost_source_id uuid references payment_sources(id),
  -- Nothing dated on or before this can be added, changed or deleted (closed year).
  lock_date date,
  timezone text not null default 'Africa/Johannesburg',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- clients and jobs
create table clients (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  contact_person text not null default '',
  email text not null default '',
  phone text not null default '',
  address text not null default '',
  vat_number text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  number int not null unique,
  name text not null,
  client_id uuid references clients(id),
  status text not null default 'active'
    check (status in ('lead', 'quoted', 'active', 'invoiced', 'done', 'cancelled')),
  site_address text not null default '',
  start_date date,
  end_date date,
  -- The estimate when there is no quote in Shap (e.g. jobs imported from the tracker).
  est_labour_cents bigint not null default 0,
  est_materials_cents bigint not null default 0,
  est_demo_cents bigint not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index projects_client on projects(client_id);

-- ---------------------------------------------------------------- workers and labour
create table workers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'permanent' check (kind in ('permanent', 'casual', 'subcontractor')),
  day_rate_cents bigint not null default 0,
  allowance_cents bigint not null default 0,
  phone text not null default '',
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- A worker's day (or part day) on a job, or on general work, or not yet allocated.
create table labour_entries (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  worker_id uuid not null references workers(id),
  project_id uuid references projects(id),
  work_type_id uuid references work_types(id),
  days numeric(6, 2) not null default 1,
  wage_cents bigint not null default 0,
  allowance_cents bigint not null default 0,
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (project_id is null or work_type_id is null)
);
create index labour_date on labour_entries(date);
create index labour_worker on labour_entries(worker_id, date);
create index labour_project on labour_entries(project_id);

-- Money handed to a worker. Earned minus paid is what you owe them (or what they owe you).
create table wage_payments (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  worker_id uuid not null references workers(id),
  amount_cents bigint not null,
  source_id uuid not null references payment_sources(id),
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index wage_payments_worker on wage_payments(worker_id, date);

-- Savings a worker asked you to keep for them. A memo, not company money: not in the ledger.
create table worker_savings (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  worker_id uuid not null references workers(id),
  amount_cents bigint not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- files (receipt photos, logo)
create table attachments (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  mime text not null,
  size int not null,
  bytes bytea not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- costs
create table planned_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  qty numeric(14, 3) not null default 1,
  unit text not null default '',
  unit_cost_cents bigint not null default 0,
  supplier text not null default '',
  category text not null default 'materials' check (category in ('materials', 'demo')),
  note text not null default '',
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table costs (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  amount_cents bigint not null,            -- what you paid, VAT included
  vat_cents bigint not null default 0,     -- claimable input VAT (VAT vendors only)
  supplier text not null default '',
  category_id uuid not null references cost_categories(id),
  source_id uuid not null references payment_sources(id),
  project_id uuid references projects(id),
  planned_item_id uuid references planned_items(id) on delete set null,
  receipt_id uuid references attachments(id),
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index costs_date on costs(date);
create index costs_project on costs(project_id);
create index costs_category on costs(category_id);

-- ---------------------------------------------------------------- quotes and invoices
create table documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('quote', 'invoice')),
  number text not null,
  status text not null default 'draft'
    check ((kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
        or (kind = 'invoice' and status in ('draft', 'issued', 'void'))),
  project_id uuid references projects(id),
  client_id uuid references clients(id),
  issue_date date not null,
  due_date date,
  title text not null default '',
  notes text not null default '',
  terms text not null default '',
  vat_rate_bp int not null default 0,
  subtotal_cents bigint not null default 0,
  vat_cents bigint not null default 0,
  total_cents bigint not null default 0,
  source_quote_id uuid references documents(id),
  void_reason text not null default '',
  sent_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, number)
);
create index documents_project on documents(project_id);
create index documents_client on documents(client_id);

create table document_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  sort int not null default 0,
  category text not null default 'labour' check (category in ('labour', 'materials', 'demo', 'other')),
  description text not null,
  qty numeric(14, 3) not null default 1,
  unit text not null default '',
  unit_price_cents bigint not null default 0,
  line_total_cents bigint not null default 0
);
create index document_lines_doc on document_lines(document_id);

-- Money received from clients, always against an invoice.
create table receipts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references documents(id),
  date date not null,
  amount_cents bigint not null,
  source_id uuid not null references payment_sources(id),
  method text not null default 'eft' check (method in ('eft', 'cash', 'card', 'other')),
  reference text not null default '',
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index receipts_invoice on receipts(invoice_id);

-- ---------------------------------------------------------------- assets
create table assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'tools' check (category in ('tools', 'vehicles', 'equipment', 'computers', 'other')),
  purchase_date date not null,
  cost_cents bigint not null check (cost_cents > 0),
  -- Either bought through a cost entry (cost_id, which then posts to the asset account)
  -- or paid from a source directly (e.g. a bakkie sold to the company by the owner).
  cost_id uuid unique references costs(id) on delete set null,
  source_id uuid references payment_sources(id),
  life_months int not null default 36 check (life_months > 0),
  residual_cents bigint not null default 0,
  disposed_on date,
  disposal_proceeds_cents bigint not null default 0,
  disposal_source_id uuid references payment_sources(id),
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- journals
create table journals (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  description text not null,
  reference text not null default '',
  kind text not null default 'manual' check (kind in ('manual', 'opening', 'import', 'adjustment')),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references journals(id) on delete cascade,
  account_id uuid not null references accounts(id),
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  memo text not null default '',
  check ((debit_cents = 0) <> (credit_cents = 0))
);
create index journal_lines_journal on journal_lines(journal_id);

-- A journal must balance by the end of the transaction that writes it.
create function journal_must_balance() returns trigger language plpgsql as $$
declare jid uuid; diff bigint;
begin
  jid := coalesce(new.journal_id, old.journal_id);
  if exists (select 1 from journals where id = jid) then
    select coalesce(sum(debit_cents - credit_cents), 0) into diff from journal_lines where journal_id = jid;
    if diff <> 0 then raise exception 'Journal does not balance (out by % cents)', diff; end if;
  end if;
  return null;
end $$;
create constraint trigger journal_balanced after insert or update or delete on journal_lines
  deferrable initially deferred for each row execute function journal_must_balance();

-- Bank or card statement balances you've checked the books against.
create table balance_checks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  date date not null,
  statement_balance_cents bigint not null,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- starting chart of accounts
insert into accounts (code, name, type, system_key) values
  ('1000', 'Bank – business account', 'asset', 'bank'),
  ('1050', 'Cash on hand', 'asset', null),
  ('1100', 'Debtors (money owed by clients)', 'asset', 'receivables'),
  ('1200', 'Work in progress (jobs not yet invoiced)', 'asset', 'wip'),
  ('1500', 'Tools & equipment at cost', 'asset', 'fixed_assets'),
  ('1510', 'Vehicles at cost', 'asset', 'fixed_assets_vehicles'),
  ('1590', 'Accumulated depreciation', 'asset', 'accumulated_depreciation'),
  ('1900', 'Suspense (to sort out)', 'asset', 'suspense'),
  ('2000', 'Creditors (money owed to suppliers)', 'liability', null),
  ('2100', 'Wages owed to workers', 'liability', 'wages_payable'),
  ('2200', 'VAT', 'liability', 'vat'),
  ('2300', 'Owner’s loan account', 'liability', 'owner_loan'),
  ('2400', 'Client deposits held', 'liability', null),
  ('2500', 'Income tax owed (SARS)', 'liability', 'income_tax_payable'),
  ('3000', 'Share capital', 'equity', 'share_capital'),
  ('3100', 'Retained earnings', 'equity', 'retained_earnings'),
  ('4000', 'Project revenue – labour', 'income', 'revenue_labour'),
  ('4010', 'Project revenue – materials', 'income', 'revenue_materials'),
  ('4020', 'Project revenue – demo', 'income', 'revenue_demo'),
  ('4090', 'Other income', 'income', 'revenue_other'),
  ('4900', 'Profit or loss on assets sold', 'income', 'disposal_gain_loss'),
  ('5000', 'Cost of sales – project labour', 'cost_of_sales', 'cos_labour'),
  ('5010', 'Cost of sales – project materials', 'cost_of_sales', 'cos_materials'),
  ('5020', 'Cost of sales – demo & removal', 'cost_of_sales', 'cos_demo'),
  ('6000', 'Accounting & admin', 'expense', null),
  ('6010', 'Advertising', 'expense', null),
  ('6020', 'Airtime, phone & data', 'expense', null),
  ('6030', 'Bank charges', 'expense', null),
  ('6040', 'Insurance', 'expense', null),
  ('6050', 'Interest', 'expense', null),
  ('6060', 'Travel – fuel', 'expense', null),
  ('6070', 'Travel – vehicle maintenance', 'expense', null),
  ('6080', 'Travel – vehicle purchase costs', 'expense', null),
  ('6090', 'Travel – fines', 'expense', null),
  ('6100', 'Gifts', 'expense', null),
  ('6110', 'Meals & entertainment', 'expense', null),
  ('6120', 'Protective & branded clothing', 'expense', null),
  ('6130', 'Small tools', 'expense', null),
  ('6140', 'General labour (not on a job)', 'expense', 'general_labour'),
  ('6150', 'Depreciation', 'expense', 'depreciation'),
  ('6900', 'Sundry expenses', 'expense', 'sundry'),
  ('7000', 'Income tax', 'expense', 'income_tax');

insert into payment_sources (name, kind, account_id, sort) values
  ('Business bank', 'bank', (select id from accounts where code = '1000'), 1),
  ('Cash', 'cash', (select id from accounts where code = '2300'), 2),
  ('Paid personally (owner)', 'owner', (select id from accounts where code = '2300'), 3);

insert into cost_categories (name, kind, account_id, sort) values
  ('Parts', 'materials', (select id from accounts where code = '5010'), 1),
  ('Demo', 'demo', (select id from accounts where code = '5020'), 2),
  ('Tool', 'overhead', (select id from accounts where code = '6130'), 3),
  ('Petrol', 'overhead', (select id from accounts where code = '6060'), 4),
  ('Vehicle Maintenance', 'overhead', (select id from accounts where code = '6070'), 5),
  ('Vehicle Transfer', 'overhead', (select id from accounts where code = '6080'), 6),
  ('Fines', 'overhead', (select id from accounts where code = '6090'), 7),
  ('PPE', 'overhead', (select id from accounts where code = '6120'), 8),
  ('Cellphone', 'overhead', (select id from accounts where code = '6020'), 9),
  ('Bank', 'overhead', (select id from accounts where code = '6030'), 10),
  ('Interest', 'overhead', (select id from accounts where code = '6050'), 11),
  ('Insurance', 'overhead', (select id from accounts where code = '6040'), 12),
  ('Accounting', 'overhead', (select id from accounts where code = '6000'), 13),
  ('Advertising', 'overhead', (select id from accounts where code = '6010'), 14),
  ('Entertainment', 'overhead', (select id from accounts where code = '6110'), 15),
  ('Gifts', 'overhead', (select id from accounts where code = '6100'), 16),
  ('Asset purchase', 'asset', (select id from accounts where code = '1500'), 17),
  ('Personal (owner)', 'personal', (select id from accounts where code = '2300'), 18),
  ('Sundry', 'overhead', (select id from accounts where code = '6900'), 19);

insert into work_types (name, sort) values
  ('Yard & workshop', 1),
  ('Quoting & site visits', 2),
  ('Vehicle & collecting stock', 3),
  ('Training', 4),
  ('Other general work', 5);

insert into settings (id, default_receipt_source_id, default_wage_source_id, default_cost_source_id, invoice_terms, quote_terms)
values (
  true,
  (select id from payment_sources where name = 'Business bank'),
  (select id from payment_sources where name = 'Cash'),
  (select id from payment_sources where name = 'Business bank'),
  'Payment due within 7 days. Please use the invoice number as your reference.',
  'This quote is valid for 30 days. A deposit may be required before materials are ordered.'
);
