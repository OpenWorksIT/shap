-- Where each account shows on the financial statements (packages/shared/src/statement-lines.ts):
-- its line, and so whether it's current or non-current and how it shows in the statement of cash
-- flows. Shap's own accounts by their key; the rest by their type (interest paid is a finance cost,
-- a cash account is cash). Changeable per account; a new account picks one when it's added.
alter table accounts add column if not exists statement_line text;

-- The line an account starts on (the same rules as defaultLineFor in statement-lines.ts).
create or replace function default_statement_line(p_key text, p_type text, p_name text) returns text
language sql immutable as $$
  select case
    when p_key = 'owner_loan' and p_type = 'equity' then 'owners_contributions'
    when p_key in ('bank') then 'cash'
    when p_key in ('receivables', 'supplier_claims') then 'trade_receivables'
    when p_key in ('wip', 'inventory') then 'inventories'
    when p_key in ('fixed_assets', 'fixed_assets_vehicles', 'accumulated_depreciation') then 'ppe'
    when p_key in ('intangible_patents', 'intangible_software', 'accumulated_amortisation') then 'intangibles'
    when p_key = 'suspense' then 'other_current_assets'
    when p_key in ('payables', 'uncaptured', 'stock_clearing', 'stock_opening', 'wages_payable', 'vat', 'credit_clearing', 'paye_payable', 'uif_payable', 'sdl_payable', 'dwt_payable') then 'trade_payables'
    when p_key = 'income_tax_payable' then 'current_tax_liability'
    when p_key = 'owner_loan' then 'shareholder_loans_current'
    when p_key = 'dividends_payable' then 'dividends_payable'
    when p_key = 'share_capital' then 'share_capital'
    when p_key = 'retained_earnings' then 'retained_earnings'
    when p_key = 'dividends' then 'distributions'
    when p_key in ('revenue_labour', 'revenue_materials', 'revenue_demo', 'revenue_goods') then 'revenue'
    when p_key = 'disposal_gain_loss' then 'other_income'
    when p_key = 'revenue_other' then 'revenue'
    when p_key = 'interest_income' then 'finance_income'
    when p_key = 'income_tax' then 'income_tax'
    when p_type = 'cost_of_sales' then 'cost_of_sales'
    when p_type = 'expense' and p_name ~* '^interest\M' then 'finance_costs'
    when p_type = 'expense' then 'operating_expenses'
    when p_type = 'income' then 'revenue'
    when p_type = 'asset' and p_name ~* '\m(cash|petty)\M' then 'cash'
    when p_type = 'asset' then 'other_current_assets'
    when p_type = 'liability' then 'trade_payables'
    -- Partners' capital and current accounts, and any other owners' equity.
    when p_type = 'equity' and p_name ~* 'capital|current account|drawings' then 'owners_contributions'
    else 'reserves'
  end
$$;

-- Which account types a line may hold.
create or replace function statement_line_fits(p_line text, p_type text) returns boolean
language sql immutable as $$
  select case p_type
    when 'asset' then p_line in ('ppe', 'intangibles', 'investments', 'loans_receivable', 'deferred_tax_asset', 'inventories', 'trade_receivables', 'current_tax_asset', 'other_current_assets', 'cash')
    when 'equity' then p_line in ('share_capital', 'owners_contributions', 'reserves', 'retained_earnings', 'distributions')
    when 'liability' then p_line in ('shareholder_loans', 'borrowings_non_current', 'deferred_tax_liability', 'provisions_non_current', 'trade_payables', 'shareholder_loans_current', 'borrowings_current', 'current_tax_liability', 'dividends_payable', 'provisions_current', 'bank_overdraft', 'other_current_liabilities')
    when 'income' then p_line in ('revenue', 'other_income', 'finance_income')
    when 'cost_of_sales' then p_line in ('cost_of_sales', 'operating_expenses')
    when 'expense' then p_line in ('cost_of_sales', 'operating_expenses', 'finance_costs', 'income_tax')
    else false
  end
$$;

update accounts set statement_line = default_statement_line(system_key, type, name) where statement_line is null;

-- Every way an account is added or changes type gets a line that fits, unless one that fits was given.
create or replace function accounts_statement_line() returns trigger language plpgsql as $$
begin
  if new.statement_line is null or not statement_line_fits(new.statement_line, new.type) then
    new.statement_line := default_statement_line(new.system_key, new.type, new.name);
  end if;
  return new;
end $$;
drop trigger if exists accounts_statement_line on accounts;
create trigger accounts_statement_line before insert or update of type, statement_line, system_key on accounts
  for each row execute function accounts_statement_line();

alter table accounts alter column statement_line set not null;
do $$ begin
  alter table accounts add constraint accounts_statement_line check (statement_line in (
    'ppe', 'intangibles', 'investments', 'loans_receivable', 'deferred_tax_asset', 'inventories', 'trade_receivables', 'current_tax_asset',
    'other_current_assets', 'cash', 'share_capital', 'owners_contributions', 'reserves', 'retained_earnings', 'distributions',
    'shareholder_loans', 'borrowings_non_current', 'deferred_tax_liability', 'provisions_non_current', 'trade_payables',
    'shareholder_loans_current', 'borrowings_current', 'current_tax_liability', 'dividends_payable', 'provisions_current', 'bank_overdraft',
    'other_current_liabilities', 'revenue', 'cost_of_sales', 'other_income', 'operating_expenses', 'finance_income', 'finance_costs', 'income_tax'));
exception when duplicate_object then null; end $$;
