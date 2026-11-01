-- Shap Pocket: one person's books on their phone.
-- Which parts of the app are switched on (see FEATURES in @shap/shared); empty means the defaults.
alter table settings add column features jsonb not null default '{}';
-- The first-run questions have been answered.
alter table settings add column setup_done boolean not null default false;
-- Where the logo sits in the heading of quotes and invoices: zoom and offset, set by dragging it.
alter table settings add column logo_layout jsonb not null default '{}';
alter table brands add column logo_layout jsonb not null default '{}';
-- The colour of headings and the amount-due box, when there's one trading name.
alter table settings add column accent text not null default '#e8731c';
-- Most people starting books on a phone trade in their own name. The first-run questions ask.
update settings set business_type = 'sole_prop', fy_end_month = 2, company_name = '' where not setup_done and company_name = 'My company';
-- No trading names until they're switched on: the business's own details go on its PDFs.
update settings set default_brand_id = null where not setup_done and company_name = '';
delete from brands b where b.name = 'My company' and not exists (select 1 from documents d where d.brand_id = b.id)
  and not exists (select 1 from projects p where p.brand_id = b.id) and not exists (select 1 from clients c where c.brand_id = b.id)
  and (select company_name from settings) = '';
update accounts set type = 'equity', name = 'Owner’s capital and drawings' where system_key = 'owner_loan' and name = 'Owner’s loan account';
