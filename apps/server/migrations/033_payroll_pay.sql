-- Payroll, closer to SARS's employees' tax rules:
--   * overtime and commission are regular pay, taxed with the salary (annualised), and commission
--     isn't counted for UIF; the "extra" is now only once-off pay (a bonus), taxed on top of the
--     tax year's earlier ones;
--   * the EMP201 month is the month the tax was deducted (the pay date), not the run's label, so
--     February's pay run paid on 1 March is on March's EMP201, as on the IRP5s.
-- Payments to SARS already recorded against a run's label move to that run's pay-date month.
alter table pay_lines add column if not exists overtime_cents bigint not null default 0;
alter table pay_lines add column if not exists commission_cents bigint not null default 0;

update sars_payments p set period = to_char(r.pay_date, 'YYYY-MM')
from pay_runs r
where p.kind = 'emp201' and r.status = 'final' and r.period = p.period and to_char(r.pay_date, 'YYYY-MM') <> r.period
  and (select count(*) from pay_runs x where x.status = 'final' and x.period = p.period) = 1;
