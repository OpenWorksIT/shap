# Leave

**Payroll → Leave.** Shap keeps each employee's leave: what's recorded, the balances worked out
from it, unpaid days off the month's pay run, annual leave paid out when someone leaves, and the
annual leave pay owed at a year end in the books. Shap does the sums from what's recorded and the
BCEA's least. It isn't a labour adviser or an accountant: what a business owes its people (a
sectoral determination, a bargaining council agreement, the contract) is the owner's to check with
theirs. The rules are in `packages/shared/src/leave.ts`; the records in `apps/server/src/lib/leave.ts`
and `modules/leave.ts`.

## The kinds of leave

| Kind | The law | What Shap does |
| --- | --- | --- |
| Annual leave | BCEA s20, s21 | Three weeks in each 12-month cycle from the start date (15 working days on a five-day week; more if the employee's terms say), earned day by day through the cycle. Owed = earned − taken ± adjustments − paid out. Leave owed from a cycle that ended more than six months ago is pointed out (s20(4)). |
| Sick leave | s22, s23 | Six weeks' working days in each 36-month cycle from the start date (30 on a five-day week); in the first six months a day for every 26 worked (taken then counts against the first cycle, s22(4)). More than two days in a row without a certificate is pointed out (s23). Unpaid sick days (past the entitlement) don't use it. |
| Family responsibility leave | s27 | Three paid days in each annual leave cycle (the employee's terms can give more: a sectoral determination may), for someone employed over four months who works at least four days a week: a sick child, or a death in the family. Not carried over. |
| Maternity, parental, adoption, commissioning parental | s25, s25A, s25B, s25C, and *Van Wyk* | Recorded by kind (the UIF claims still differ). Since the Constitutional Court's order of 3 October 2025, until Parliament amends the Act, the parents share four months and ten days (one employed parent alone has all of it); a birth mother may start four weeks before the birth and doesn't work for six weeks after. Unpaid by default: the BCEA doesn't make the employer pay it, the UIF pays benefits. A contract may pay it: tick *Paid*. |
| Unpaid leave | by agreement | Comes off the month's pay run. |
| Other leave | by agreement | Study, religious or special leave: paid unless unticked. |

A leave entry has its first and last day and the working days in between (Shap suggests them:
Monday to Friday on a five-day week, to Saturday on six, public holidays left out). Entries for one
person can't overlap. Annual leave can be **adjusted** (days added, or with a minus taken off) with
the reason: a correction, extra days given, leave paid out some other way.

**Someone already on payroll** when leave came in (1.34) has their leave records start that day,
with nothing owed until the owner gives what was owed then (Employees → their leave: the annual
leave owed, and the sick and family responsibility days already taken in the cycles running then).
Counting from their start date with nothing recorded would say they'd never had leave.

## In the pay run

- **Unpaid leave** in the run's month comes off the salary at a day's pay: BCEA s35(3) makes a month
  four and one-third weeks, so a day is the monthly salary × 3 ÷ 13 ÷ the days worked in a week.
  Never more than the month's salary. `pay_lines.salary_cents` stays the full salary; the deduction
  is `unpaid_leave_cents`. IRP5 code 3601 is the salary less it.
- **Leaving in the month:** the annual leave owed on the last day is paid out (s40), at a day's pay,
  unless the owner gives the days. It's an annual payment for PAYE (SARS: leave pay on resignation
  is an annual payment, IRP5 code 3605) and counts for UIF.
- A draft run picks up leave as it's recorded; a final one doesn't change (reopen it).
- The payslip shows the unpaid days and leave paid out, and the balances at the month's end.

## In the books

Annual leave owed at a year end is a liability (IFRS for SMEs 28.6: accumulating compensated
absences, at the undiscounted additional amount the business expects to pay, presented as a
current liability). It's an accrual, within trade and other payables (account 2630 Leave pay owed).
Sick, family responsibility and parents' leave isn't paid out, so nothing is owed for it (28.7: the
cost is recognised when the absence happens).

The owner **books it** once the year has ended (Payroll → Leave): one journal at the year end (kind
`leave_pay`) moves Leave pay owed to what the leave records say, against salaries (a director's part
against their remuneration). Booked again, it's replaced, and any later year booked from it is too.
The books audit says when the leave records have changed since, or when a year end has leave owed
and nothing booked; the statements' checks show it.

**Tax:** leave pay is variable remuneration, incurred only when paid (Income Tax Act s7B), so the
year's increase in leave pay owed isn't deductible: the tax pack, the statements' tax estimate and
the assessed loss add it back (a decrease comes off).

## Sources

- Basic Conditions of Employment Act 75 of 1997, Chapter Three:
  [lawlibrary.org.za](https://lawlibrary.org.za/akn/za/act/1997/75/eng@2020-01-01/source)
- *Van Wyk and Others v Minister of Employment and Labour* [2025] ZACC 20 (3 October 2025):
  [SAFLII](https://www.saflii.org/za/cases/ZACC/2025/20.html); a summary:
  [Labour Research Service](https://lrs.org.za/2025/11/05/key-takeaway-from-the-concourt-ruling-on-parental-leave/)
- SARS, annual payments (leave pay on resignation, code 3605):
  [sars.gov.za](https://www.sars.gov.za/faq/faq-what-does-sars-mean-by-annual-payments/)
- Section 7B, variable remuneration: [The Tax Faculty](https://taxfaculty.ac.za/index.php/news/read/variable-remuneration-section-7b)
- IFRS for SMEs (2025), Section 28, 28.6 and 28.7:
  [IFRS Foundation module 28](https://www.ifrs.org/content/dam/ifrs/supporting-implementation/smes/2025-modules/module-28.pdf)
