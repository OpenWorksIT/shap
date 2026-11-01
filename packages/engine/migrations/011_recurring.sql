-- Monthly costs Shap expects (insurance, bank fees, subscriptions): ones you've said stopped
-- on purpose, and months you've said to skip.
-- SPDX-License-Identifier: AGPL-3.0-or-later
create table recurring_marks (
  -- The pattern: cost type and supplier, as Shap groups them.
  key text not null,
  -- 'YYYY-MM' for a skipped month; '' when the whole pattern is stopped.
  month text not null default '',
  kind text not null check (kind in ('stopped', 'skipped')),
  user_id uuid references users(id),
  at timestamptz not null default now(),
  primary key (key, month)
);
