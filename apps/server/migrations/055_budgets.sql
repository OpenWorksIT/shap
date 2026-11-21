-- Budgets (1.33): what the business expects each income statement account to come to, month by
-- month, in a financial year, to set against what the books show (budget against actual). A plan,
-- not the books: nothing is posted from it.
create table if not exists budgets (
  account_id uuid not null references accounts(id) on delete cascade,
  -- The financial year's last day.
  fy_end date not null,
  -- The year's twelve months, its first month first, in cents: income and costs alike as amounts
  -- the account is expected to come to (a cost is a positive number).
  months bigint[] not null check (cardinality(months) = 12),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (account_id, fy_end)
);
