-- More first-run answers: the app's tone, what the business does, whether it may say so
-- (anonymously), and payroll's Skills Development Levy.
alter table settings add column tone text not null default 'casual' check (tone in ('casual', 'formal'));
alter table settings add column industry text not null default '';
alter table settings add column usage_consent boolean not null default false;
-- A random number for this set of books, so anonymous counts don't count the same business twice.
alter table settings add column install_id uuid not null default gen_random_uuid();
alter table settings add column sdl boolean not null default false;
-- A card payment link (Yoco, SnapScan, a bank's pay-by-link…) printed on invoices: the
-- business's usual one, and one per invoice when it's made for that amount.
alter table settings add column pay_link text not null default '';
alter table documents add column pay_link text not null default '';
