# Casual labour and the law

Shap's **Workers** record day labour: who worked which days, on which job, at what day rate, and
what they were paid (cash, an advance, savings held for them). Plenty of small South African
businesses pay helpers by the day like this. The law mostly treats those helpers as **employees**,
and most of what follows is the business's to handle, not Shap's. Shap records the days and the
pay; it doesn't work out, deduct or pay UIF, employees' tax or the Compensation Fund's assessment
for a worker. Employees on **Payroll** get PAYE, UIF and SDL worked out, the EMP201 and the EMP501.

Shap is free software from OpenWorks IT, who are not accountants, tax practitioners or labour
lawyers. This page says where the law starts to apply so the owner knows to look; it isn't advice.
Check how you employ and pay your workers with your accountant or a labour practitioner.

## What the law says

| Law | What it means for day labour | Source |
|---|---|---|
| Unemployment Insurance Contributions Act s4(1)(a) | UIF applies to everyone employed by an employer for **24 hours a month or more**: 1% from the worker and 1% from the employer (s6), deducted from their pay (s7) and paid monthly, to SARS with the EMP201 or, for an employer not registered for PAYE or SDL, to the UIF itself (s8, s9). The employer registers (s10) | [UICA s4 (Acts Online)](https://source.acts.co.za/unemployment-insurance-contributions-act-2002/4__application_of_act.php), [UICA (SAFLII)](https://www.saflii.org/za/legis/consol_act/uica2002443) |
| Basic Conditions of Employment Act s6(1)(c) | From 24 hours a month with an employer, the whole working-time chapter applies (hours, overtime, meal intervals, Sunday and public holiday work). The rest of the Act (leave, written particulars, records of time and pay, notice) applies to employees generally | [BCEA s6 (Acts Online)](https://source.acts.co.za/basic-conditions-of-employment-act-1997/bcoe97_6__application_of_this_chapter.php) |
| Labour Relations Act, Employment Equity Act | Someone under 24 hours a month is still an employee for the LRA's protections (unfair dismissal) and the EEA | [CEOSA on casual labourers](https://ceosa.org.za/do-not-be-too-casual-when-it-comes-to-workers/) |
| LRA s198B | For someone earning at or under the BCEA earnings threshold (R269 900.90 a year from 1 May 2026), a fixed-term or "casual" arrangement beyond three months needs a justifiable reason, or it's deemed permanent; after three months, no less favourable treatment than a permanent employee. Employers with fewer than 10 employees (or fewer than 50 in their first two years) are excluded | [Section 198B (summary)](https://topsourceworldwide.com/glossary/section-198b-fixed-term-rule-south-africa/), [BCEA earnings threshold 2026](https://acts.co.za/news/blog/2026/04/bcea-earnings-threshold-increase-2026) |
| National Minimum Wage Act | R30.23 an ordinary hour from 1 March 2026 (R28.79 before), for every worker not under a bargaining council's own minimum | [National minimum wage from 1 March 2026](https://acts.co.za/news/blog/2026/02/new-national-minimum-wage-rates-1-march-2026) |
| Income Tax Act, Fourth Schedule | Day wages are remuneration: employees' tax applies. Someone not in "standard employment" (usually not employed for at least 22 hours a week) has a flat 25% withheld, unless an exception applies (a written declaration that they don't work for another employer, among others); otherwise SARS's tables, under which a low wage may come to no tax | [SARS: other deduction tables (non-standard employment, 25%)](https://www.sars.gov.za/paye-gen-01-g01-a06-2025-other-employment-tax-deduction-tables-external-annexure), [SimplePay on non-standard employment](https://www.simplepay.co.za/help/payroll-concepts/non-standard-employment/), [SARS guide for employers (2026)](https://www.sars.gov.za/guide-for-employers-in-respect-of-employees-tax-2026) |
| Skills Development Levies Act | A casual worker's pay counts towards the R500 000 a year payroll above which SDL is due | [SARS: SDL](https://www.sars.gov.za/types-of-tax/skills-development-levy/) |
| COIDA | A casual employee employed for the employer's business is an employee for the Compensation Fund: an employer with one or more employees registers, and their wages go on the return of earnings | [Who must register for COIDA](https://www.eohcb.co.za/post/coida-who-must-register-for-coida) |
| Subcontractors | Someone who runs their own business and invoices you is a contractor, not an employee. Where you control how, when and where they work, SARS and the labour laws can see them as an employee | [SARS Interpretation Note 17 (summary)](https://cliffedekkerhofmeyr.com/news/publications/2019/Employment/employment-alert-18-march-sars-interpretation-note-17-when-will-an-employer-be-liable-for-employees-tax-in-respect-of-an-independent-contractor.html) |

## What Shap does about it

- **Workers** says, on the list and on each worker, where the law starts to apply from the days
  logged: about 24 hours a month or more (a day logged counts as 8 hours: Shap logs days, not
  hours), and a day rate under the national minimum wage for a full day. The worker's page marks
  each month they reached 24 hours. These are reminders, worked out from what's logged.
- The same note is on the workers list, the worker's page and the form for adding a worker, and
  setup says it when it asks about casual labour.
- A subcontractor gets the independent contractor note instead.
- Someone who works for the business regularly belongs on **Payroll**, where PAYE, UIF and SDL are
  worked out and go on the EMP201.
- The records Shap keeps (days, rates, what was paid and when) are the kind the BCEA asks an
  employer to keep (s31: three years).

Shap doesn't decide whether someone is an employee, doesn't deduct UIF or tax from day wages, and
doesn't file anything for them. The national minimum wage table is in
`packages/shared/src/labour.ts`, checked each year with the SARS tables (CPDAUDIT.md section 2).
