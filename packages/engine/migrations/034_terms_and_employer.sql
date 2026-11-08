-- The terms of use each set of books accepted (version and when; the acceptance is also in the
-- audit log), the business's income tax number, and its employer registrations (PAYE and UIF,
-- asked in setup when there are employees: SDL already had its own switch).
alter table settings add column if not exists terms_version text not null default '';
alter table settings add column if not exists terms_accepted_at timestamptz;
alter table settings add column if not exists tax_number text not null default '';
alter table settings add column if not exists paye_registered boolean;
alter table settings add column if not exists paye_ref text not null default '';
alter table settings add column if not exists uif_registered boolean;
alter table settings add column if not exists uif_ref text not null default '';

-- A company, Inc., CC or co-op declares its dividends (or members' distributions) to SARS on the
-- DTR01: the dividends section is always on for them.
update settings set features = features || '{"dividends": true}'::jsonb
  where business_type in ('company', 'inc', 'cc', 'coop') and coalesce((features ->> 'dividends')::boolean, false) = false;
