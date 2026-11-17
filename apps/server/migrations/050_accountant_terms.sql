-- The Shap Accountant terms of use (terms.ts ACCOUNTANT_TERMS_VERSION): accepted by a practice's
-- owner for the practice, before Shap Accountant is switched on and whenever they change. Kept in
-- the practice's own settings, beside Shap's terms (terms_version), with the audit log's record.
alter table settings
  add column if not exists accountant_terms_version text not null default '',
  add column if not exists accountant_terms_accepted_at timestamptz;
