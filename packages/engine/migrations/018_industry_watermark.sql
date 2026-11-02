-- The Shap line at the foot of quotes, invoices and payslips ("Made with Shap…"): on unless
-- the business switches it off in Settings.
alter table settings add column watermark boolean not null default true;

-- Expense accounts for the cost types other kinds of business need (a salon's chair rent, a
-- designer's courses, a photographer's lens hire). Cost types for them are added when the kind
-- of business is chosen.
insert into accounts (code, name, type, system_key) values
  ('6200', 'Rent', 'expense', 'rent'),
  ('6210', 'Training & courses', 'expense', 'training'),
  ('6220', 'Printing & stationery', 'expense', 'printing'),
  ('6230', 'Equipment hire', 'expense', 'equipment_hire')
on conflict (code) do nothing;
