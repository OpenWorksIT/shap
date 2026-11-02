-- The first-run questions and what they decide (shared with Shap Pocket):
-- which parts of the app are on, the app's tone, the logo's placement and colour, what the
-- business does, whether the app may say so (anonymously), payroll's SDL, a card payment link.
alter table settings add column features jsonb not null default '{}';
alter table settings add column setup_done boolean not null default false;
alter table settings add column logo_layout jsonb not null default '{}';
alter table brands add column logo_layout jsonb not null default '{}';
alter table settings add column accent text not null default '#e8731c';
alter table settings add column tone text not null default 'casual' check (tone in ('casual', 'formal'));
alter table settings add column industry text not null default '';
alter table settings add column usage_consent boolean not null default false;
alter table settings add column install_id uuid not null default gen_random_uuid();
alter table settings add column sdl boolean not null default false;
alter table settings add column pay_link text not null default '';
alter table documents add column pay_link text not null default '';

-- Books already in use: set up as they are, with everything they use switched on.
update settings set setup_done = true,
  features = '{"jobs": true, "quotes": true, "workers": true, "bank": true, "assets": true, "brands": true}'
where company_name <> 'My company' or exists (select 1 from documents) or exists (select 1 from costs) or exists (select 1 from labour_entries);

-- New books: no placeholder trading name; the business's own details go on its PDFs until
-- trading names are switched on.
update settings set default_brand_id = null where not setup_done;
delete from brands b where not (select setup_done from settings)
  and not exists (select 1 from documents d where d.brand_id = b.id)
  and not exists (select 1 from projects p where p.brand_id = b.id)
  and not exists (select 1 from clients c where c.brand_id = b.id);
