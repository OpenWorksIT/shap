-- A sole proprietor (one person trading in their own name) or a company. Sole proprietors are
-- taxed on the tables for individuals, their year ends in February, and money they put in or
-- take out is capital and drawings rather than a loan.
alter table settings add column business_type text not null default 'company' check (business_type in ('company', 'sole_prop'));
