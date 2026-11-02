-- The usual hourly rate: for time with no job, and jobs that don't set their own.
alter table settings add column hourly_rate_cents bigint not null default 0;
