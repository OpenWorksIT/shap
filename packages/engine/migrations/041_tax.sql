-- Small business corporations, VAT categories D and E, and provisional tax paid (Shap 1.23.2, Pocket 1.7.2).

-- Whether the company qualifies as a small business corporation (s12E): yes, no, or not said yet.
-- The provisional tax estimate, the financial statements and the tax pack all go by it.
alter table settings add column if not exists sbc boolean;
-- A company that saved a provisional tax estimate on the small business corporation table said so.
update settings set sbc = true
where sbc is null and exists (select 1 from tax_estimates e where (e.lines ->> 'sbc')::boolean);

-- VAT categories D (six-monthly) and E (yearly), beside A, B and C.
alter table settings drop constraint if exists settings_vat_category_check;
alter table settings add constraint settings_vat_category_check check (vat_category in ('A', 'B', 'C', 'D', 'E'));

-- Provisional tax (IRP6) paid to SARS: towards the year's income tax.
alter table sars_payments drop constraint if exists sars_payments_kind_check;
alter table sars_payments add constraint sars_payments_kind_check check (kind in ('emp201', 'dwt', 'irp6'));
