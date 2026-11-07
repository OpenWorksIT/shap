-- This Shap's anonymous usage note (only if the owner agreed) now goes out when something in it
-- changed, an update included, and otherwise once a month while it's running: so OpenWorks knows
-- how many Shaps are in use and how many took each update. This remembers what was last sent.
alter table settings add column if not exists usage_sent text not null default '';
alter table settings add column if not exists usage_sent_at timestamptz;
