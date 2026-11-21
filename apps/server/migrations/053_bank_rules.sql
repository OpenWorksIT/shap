-- Bank rules (1.33): "a statement line that says X is this cost type (or this income)". When a
-- statement comes in, Shap fills in a line's cost type and supplier from the rule it fits, ahead
-- of its own guess. Nothing is captured until someone ticks the line, so a rule never posts
-- anything by itself.
create table if not exists bank_rules (
  id uuid primary key default gen_random_uuid(),
  -- What the line's description contains (any case, any spacing).
  match_text text not null check (length(match_text) between 3 and 60),
  -- Money out (a cost) or money in (income, or a refund on a cost type).
  direction text not null default 'out' check (direction in ('out', 'in')),
  category_id uuid references cost_categories(id) on delete cascade,
  income_account_id uuid references accounts(id) on delete cascade,
  supplier text not null default '' check (length(supplier) <= 120),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((category_id is null) <> (income_account_id is null)),
  check (income_account_id is null or direction = 'in')
);
create unique index if not exists bank_rules_text on bank_rules (lower(match_text), direction);
