-- Finding costs captured twice looks for the same amount around the same date.
-- SPDX-License-Identifier: AGPL-3.0-or-later
create index if not exists costs_amount_date on costs(amount_cents, date);
