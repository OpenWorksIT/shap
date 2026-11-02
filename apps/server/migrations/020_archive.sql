-- Closed years, archived: their slip photos squeezed smaller to save space. The figures don't change.
create table archived_years (
  fy_end date primary key,
  archived_at timestamptz not null default now(),
  photos int not null default 0,
  bytes_before bigint not null default 0,
  bytes_after bigint not null default 0
);
