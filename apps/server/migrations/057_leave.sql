-- Leave (packages/shared/src/leave.ts, docs/LEAVE.md): each employee's leave terms, the leave they
-- take, what an unpaid day takes off a pay run and what's paid out on leaving, and the annual leave
-- pay owed at a year end in the books (IFRS for SMEs 28.6: a current liability, measured at the
-- undiscounted amount; within trade and other payables, as an accrual).

alter table employees add column if not exists leave_days_per_week numeric(3,1) not null default 5
  check (leave_days_per_week > 0 and leave_days_per_week <= 7);
-- Null: the BCEA's three weeks for the days they work (s20(2)).
alter table employees add column if not exists annual_leave_days numeric(5,2) check (annual_leave_days >= 0 and annual_leave_days <= 366);
alter table employees add column if not exists family_leave_days numeric(4,1) not null default 3 check (family_leave_days >= 0 and family_leave_days <= 30);
-- When Shap's leave records start (if after the start date), and what was owed or taken by then.
alter table employees add column if not exists leave_from date;
alter table employees add column if not exists leave_opening_annual numeric(6,2) not null default 0;
alter table employees add column if not exists leave_opening_sick numeric(6,2) not null default 0 check (leave_opening_sick >= 0);
alter table employees add column if not exists leave_opening_family numeric(6,2) not null default 0 check (leave_opening_family >= 0);

-- Someone already on payroll: Shap's leave records for them start today, with nothing owed until
-- the owner gives what was owed then (the Leave tab asks). Counting from their start date with no
-- leave recorded would say they're owed every day since.
update employees set leave_from = current_date where leave_from is null and start_date < current_date;

create table if not exists leave_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  kind text not null check (kind in ('annual', 'sick', 'family', 'maternity', 'parental', 'adoption', 'commissioning', 'unpaid', 'other')),
  -- Annual leave added (days > 0) or taken off (days < 0) without leave being taken, with its reason.
  adjustment boolean not null default false,
  from_date date not null,
  to_date date not null,
  days numeric(6,2) not null,
  paid boolean not null default true,
  certificate boolean not null default false,
  reason text not null default '' check (reason in ('', 'child_sick', 'death')),
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (to_date >= from_date),
  check ((adjustment and kind = 'annual' and days <> 0) or (not adjustment and days > 0))
);
create index if not exists leave_entries_employee on leave_entries(employee_id, from_date);

-- A pay run's line: unpaid leave in the month comes off the salary (salary_cents stays the month's
-- full salary); annual leave paid out on leaving is taxed as an annual payment (IRP5 code 3605).
alter table pay_lines add column if not exists unpaid_leave_days numeric(6,2) not null default 0;
alter table pay_lines add column if not exists unpaid_leave_cents bigint not null default 0 check (unpaid_leave_cents >= 0);
-- The days paid out (worked out from the leave records, or the owner's when they gave them: given).
alter table pay_lines add column if not exists leave_paid_out_days numeric(6,2) not null default 0 check (leave_paid_out_days >= 0);
alter table pay_lines add column if not exists leave_paid_out_given numeric(6,2) check (leave_paid_out_given >= 0);
alter table pay_lines add column if not exists leave_paid_out_cents bigint not null default 0 check (leave_paid_out_cents >= 0);

insert into accounts (code, name, type, system_key) values ('2630', 'Leave pay owed', 'liability', 'leave_payable')
on conflict do nothing;

alter table journals drop constraint journals_kind_check;
alter table journals add constraint journals_kind_check
  check (kind in ('manual', 'opening', 'import', 'adjustment', 'payroll', 'dividend', 'sars', 'profit_share', 'leave_pay'));

-- The annual leave pay owed at a year end, booked: one journal at the year end for the year's change
-- (booked again, it's replaced), and each person's days, day's pay and amount as they were.
create table if not exists leave_pay_years (
  fy_end date primary key,
  -- None when nothing changed in the year.
  journal_id uuid references journals(id) on delete cascade,
  owed_cents bigint not null,
  people jsonb not null default '[]',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
