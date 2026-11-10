-- Small business corporations, VAT categories D and E, and provisional tax paid (Shap 1.23.2, Pocket 1.7.2).

-- Whether the company qualifies as a small business corporation (s12E), year by year: SARS tests
-- it each year of assessment. A year not answered takes the latest answer before it; none: not
-- said, and the estimates show both figures. Only ever what someone chose (nothing is inferred
-- from estimates saved before, which had the box ticked by default).
create table if not exists sbc_years (
  fy_end date primary key,
  sbc boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- VAT categories D (six-monthly) and E (yearly), beside A, B and C.
alter table settings drop constraint if exists settings_vat_category_check;
alter table settings add constraint settings_vat_category_check check (vat_category in ('A', 'B', 'C', 'D', 'E'));

-- Provisional tax (IRP6) paid to SARS: towards the year's income tax.
alter table sars_payments drop constraint if exists sars_payments_kind_check;
alter table sars_payments add constraint sars_payments_kind_check check (kind in ('emp201', 'dwt', 'irp6'));
