-- Anonymous market rates (modules/market.ts): on unless switched off in Settings. Nothing is
-- shared from a set of books until the owner has been told about it (setup, or a one-time note
-- on Home): market_notice_seen. market_sent_month is the last month shared.
alter table settings add column if not exists market_consent boolean not null default true;
alter table settings add column if not exists market_notice_seen boolean not null default false;
alter table settings add column if not exists market_sent_month text not null default '';
