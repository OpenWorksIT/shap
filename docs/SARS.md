# The SARS register

Every tax and SARS figure Shap and Shap Pocket work with: where it lives in the code, SARS's own
page for it, the years it covers, and when it was last checked. The SARS review (CPDAUDIT.md)
works through this list on every update, and it's where to start when SARS changes something.

The code keeps tables by year: a table applies to years of assessment ending on or after its
`from`, so an unchanged year needs no new row. `SARS_CHECKED_TO` (`packages/shared/src/tax.ts`) is
the last year of assessment checked against SARS: from the day after, CI fails until the next
year's figures are checked and put in (the standard update, CPDAUDIT.md).

Everything here is in the shared code, so it is the same in Shap Pocket, except what's marked
*Shap only*: CIPC's annual return, the Compensation Fund's return of earnings and the cash-flow
forecast (from 1.33).

The test server's made-up books (`apps/server/src/testdata/populate.ts`, `slip.ts`;
docs/TEST_SERVER.md) take every rate and limit from the shared code too (`vatRateOn`,
`vatThresholds`, `turnoverTaxLimit`, `NO_TAX_INVOICE_CENTS`, `estimateTax`, `provisionalPayable`,
`turnoverTax`): a SARS change reaches them with the rest. Its own rules of thumb (payroll kept
under SDL's R500 000 a year without SDL, trade kept to 70% of the VAT and turnover tax lines) are
worth a look when those lines move.

**Checked up to the year ending 28 February 2027 (2026/27), on 10 November 2026** (tax invoices again for 1.24); CIPC, the Compensation Fund and the forecast's tax figures on 21 November 2026 (1.33).

The 2026/27 figures from Budget 2026 (the individual tables and rebates, the R2.3 million VAT and
turnover tax limits, the R430 000 retirement cap) were still in Parliament when checked: the
Rates and Monetary Amounts and Amendment of Revenue Laws Bill
[[B34—2026](https://www.parliament.gov.za/storage/app/media/Bills/2026/B34-2026_Rates_and_Monetary_Amounts.pdf)]
and the Taxation Laws Amendment Bill [B32—2026], introduced on
[21 October 2026](https://www.accountingweekly.com/sars-updates/three-2026-tax-bills-introduced-in-parliament-on-21-october).
SARS applies them from 1 March 2026 (1 April 2026 for VAT) as proposed; when the Acts are
promulgated, check the figures against them (the standard update). The 2025/26 tables are law: the
[Rates and Monetary Amounts and Amendment of Revenue Laws Act 3 of 2026](https://www.sars.gov.za/wp-content/uploads/Legal/AmendActs/Legal-LPrim-AA-2026-01-Rates-and-Monetary-Amounts-and-Amendment-of-Revenue-Laws-Act-3-of-2026-GG-54446-1-April-2026.pdf)
(1 April 2026).

## Income tax

| Figure | Where | Years in the code | Source |
| --- | --- | --- | --- |
| Company rate: 27% for years ending on or after 31 March 2023, 28% before | `tax.ts` `companyRate` | all | [SARS: companies, trusts and SBCs](https://www.sars.gov.za/tax-rates/income-tax/companies-trusts-and-small-business-corporations-sbc/) |
| Small business corporation tables (the top band at the company rate) | `tax.ts` `SBC_TABLES`, `sbcTableFor` | 2021 to 2027 (years ending 1 April 2020 to 31 March 2027) | same |
| SBC gross income limit R20 million; the other s12E tests (shareholders, other shares, personal service, investment income) are the business's to say, year by year (on the statements and the IRP6 screen; a year not answered takes the last year's answer, none shows both figures). Gross income is taken as the income accounts, other income (4900) included | `tax.ts` `SBC_GROSS_INCOME_LIMIT_CENTS`, `sbcApplies`; `books.ts` `sbcAnswer`; table `sbc_years` | all | [SARS Budget 2026 FAQ](https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/) |
| Trusts 45% (on what they keep: distributions up to the year's income are the beneficiaries', s25B) | `tax.ts` `estimateTax` | all | SARS: companies, trusts and SBCs (above) |
| Trust filing: the IT3(t) (what each beneficiary was given) first, by 30 September 2026 for 2026; the ITR12T 19 September 2026 to 22 January 2027 | `Guides.tsx`, `entities.ts` | 2026 season | [SARS: trust filing season](https://www.sars.gov.za/latest-news/media-release-trust-filing-season-set-to-open/) |
| Individuals: tables, rebates and thresholds | `tax.ts` `INDIVIDUAL_TABLES` | 2023 to 2027 (earlier years use 2023's) | [SARS: rates for individuals](https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/) |
| Retirement contributions: 27.5%, capped at R350 000 (R430 000 from 2027) | `tax.ts` `retirementDeduction` | 2023 to 2027 | SARS Budget 2026 FAQ (above) |
| Assessed loss: carried forward year by year, a company's set-off limited to the greater of R1 million and 80% of taxable income (years ending on or after 31 March 2023) | `tax.ts` `assessedLossSetOff`, `assessedLossCarried` | all | [SARS BGR 73](https://www.sars.gov.za/legal-intr-r-bgr-73-meaning-of-taxable-income-for-purposes-of-setting-off-the-balance-of-an-assessed-loss-by-a-company) |
| Provisional tax (IRP6): first period half the year's tax, second the rest, less what's been paid (the payments recorded for the year). The screen works out the amount; SARS's due dates are in the guide and on a practice's list (below), not on this screen | `tax.ts` `provisionalPayable`, the IRP6 screen | all | [SARS guide to provisional tax](https://www.sars.gov.za/guide-to-provisional-tax/) |
| Turnover tax: tables and the micro business limit (R1 million, R2.3 million from the year ending February 2027); TT02 payments end August and end February; TT03 1 July to 31 January | `tax.ts` `TURNOVER_TABLES`, `turnoverTaxLimit` | 2022 to 2027 | [SARS: turnover tax rates](https://www.sars.gov.za/tax-rates/turnover-tax/), [turnover tax](https://www.sars.gov.za/types-of-tax/turnover-tax/) |
| A company on turnover tax needs a February year end | `settings.ts` | until the Budget 2026 proposal is law | [TT01 FAQ](https://www.sars.gov.za/legal-pub-faqs-tt01-faqs-on-turnover-tax); watch: the [Budget 2026 FAQ](https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/) proposes dropping it |
| Not a micro business, so no turnover tax: more than 20% of receipts from a professional service (accounting, consulting, education, health, information technology, law and the others para 1 lists; a company's investment income counts too). Setup and Settings say so for the kinds of business that are such services, and choosing an accounting practice switches turnover tax off | `setup.ts` `PROFESSIONAL_SERVICE_INDUSTRIES`, `TURNOVER_TAX_PROFESSIONAL`, `terms.ts` `setupCautions` | all | [Sixth Schedule para 1](https://www.acts.co.za/income-tax/sch6_1__definitions) ("professional service"), [para 3(b)](https://www.acts.co.za/income-/sch6_3__persons_that_do_not_qualify_as_micro_businesses), [SARS FAQ: who doesn't qualify](https://www.sars.gov.za/faq/faq-who-does-not-qualify-to-be-registered-for-turnover-tax/) |
| Filing seasons (ITR12, ITR14, ITR12T) shown in the guides | `Guides.tsx` | 2026 season | [SARS filing season 2026](https://www.sars.gov.za/filing-season-2026-leaflet/) |

## The returns on a practice's list (Shap Accountant)

The practice's list of clients (docs/ACCOUNTANT.md) shows some of the returns coming up for each,
worked out again each time it's shown: `practice.ts` `deadlinesFor`, from the client's settings
and the days dividends were paid: in Shap's dividends, in a ledger brought in, and by journal by
hand (a month's hand journals to Dividends count when they come to a dividend paid), looking back
far enough for a DTR01 still on the list (`healthOf`). For a client on its own Shap, they're worked
out on the practice's own server, with its tables, from what the client's Shap sent at the last
**Run the checks** (`deadlineInputs`: the kind of business, VAT registration and category, the
year-end month, turnover tax, whether it employs people, PBO approval and those days); there's no
refresh on leaving the books, as there is for a kept client.
The dates the law fixes are in code there; the filing season's, which SARS sets each year, are in
`tax.ts` `FILING_SEASON_DATES`; a public holiday the President declares for one year is in
`dates.ts` `DECLARED_HOLIDAYS`; the Compensation Fund's return of earnings season, which the Fund
gazettes each year, is in `tax.ts` `ROE_SEASONS`. Each standard update checks all four.

| Return | Rule | Where | Source |
| --- | --- | --- | --- |
| VAT201 | Last business day of the month after the period on eFiling (the 25th otherwise, said in the label); Category E on the year of assessment (a trust's and an individual's: February) | `deadlinesFor`, `vat201Due`, `vat201Label` | [SARS: obligations of a vendor](https://www.sars.gov.za/types-of-tax/value-added-tax/obligations-of-a-vat-vendor/), [VAT Act s27](https://www.acts.co.za/value-added-tax-act-1991/27__tax_period) |
| EMP201 | By the 7th of the month after (the business day before), nil ones included, for an employer registered for PAYE | `emp201Due` | [SARS: EMP201](https://www.sars.gov.za/types-of-tax/pay-as-you-earn/emp-201-completion/) |
| IRP6 | First at the end of the sixth month of the year of assessment, second on its last business day, the voluntary third seven months after a February year end (six after any other); each partner's own; none for an approved PBO | `deadlinesFor` | [SARS FAQ: when is provisional tax paid](https://www.sars.gov.za/faq/faq-when-must-provisional-tax-be-paid/), [provisional tax](https://www.sars.gov.za/businesses-and-employers/provisional-tax/) |
| Turnover tax | TT02 at the end of August and February (each partner's own); a company's TT03 12 months after its year end. An individual's TT03 isn't shown (SARS's pages give 1 July to 31 January, and the notice 23 October and 22 January) | `deadlinesFor` | [SARS: TT03](https://www.sars.gov.za/types-of-tax/turnover-tax/annual-return/), [TT01 guide 3.5](https://www.sars.gov.za/legal-pub-guide-tt01-tax-guide-for-micro-businesses) |
| ITR14, IT12EI | 12 months after a company's (an NPC's) year end; an approved PBO files the IT12EI instead | `deadlinesFor` | [GN 7422 (2026) para 4(a)](https://www.gov.za/sites/default/files/gcis_document/202604/54598gon7422.pdf) |
| DTR01 | The end of the month after a dividend is paid | `dwtDue` | [SARS: dividends tax](https://www.sars.gov.za/types-of-tax/dividends-tax/) |
| ITR12 (provisional taxpayers, each partner's), ITR12T, IT3(t), EMP501 interim | 22 January 2027, 22 January 2027, 30 September 2026, 30 October 2026 (31 October a Saturday) | `FILING_SEASON_DATES` | [SARS: tax season 2026](https://www.sars.gov.za/types-of-tax/personal-income-tax/tax-season/), [trust filing season](https://www.sars.gov.za/media-release/trust-filing-season-set-to-open/), [PAYE interim season](https://www.sars.gov.za/latest-news/paye-interim-filing-season-opens-today-21-september-2026/) |
| A declared public holiday | 4 November 2026 (the local government elections) | `DECLARED_HOLIDAYS` | [SAnews](https://www.sanews.gov.za/node/84344) |
| CIPC annual return (not SARS's; *Shap only*: on the list and Home since 1.33) | A company (Pty, Inc, NPC): within 30 business days after each anniversary of its incorporation (Companies Act s33(1), reg 30(1)(c); the anniversary itself not counted). A close corporation: by the end of the month after its anniversary month (Close Corporations Act s15A). The first a year after incorporation; from the date of incorporation in Settings → Company (optional). A co-operative files one with CIPC too: Shap doesn't work out its date, and says so (setup, Settings). External and domesticated companies (reg 30(1), 30(6)) aren't a kind of business in Shap. What goes with the return (the statements or the financial accountability supplement, the securities register, beneficial ownership) is the accountant's | `tax.ts` `cipcAnnualReturns`, `addBusinessDays`; `practice.ts` `cipcKind` | [Companies Regulations, 2011, reg 30](https://www.acts.co.za/companies-act-2008/r351_30__company_annual_returns), [Close Corporations Act s15A](https://www.acts.co.za/close-corporations-act-1984/15a__annual_return), [co-operatives: CIPC Notice 67 of 2024 (SA Accounting Academy)](https://accountingacademy.co.za/news/read/cipc-annual-submission-of-reports-and-filling-of-annual-returns-for-co-operatives) |
| Return of earnings, Compensation Fund (COIDA; not SARS's; *Shap only*: since 1.33) | The season the Fund announces each year for the assessment year just ended: for March 2025 to February 2026, 1 April to 30 June 2026. The Fund may extend a season, and gives final dates for outstanding returns (for 2025 and earlier, 31 October 2026, Notice 4140 of 2026; in 2025 the season was extended to 31 July, Notice 3200 of 2025): the yearly check reads those too, though `ROE_SEASONS` keeps only the season's dates (a later final date isn't shown). Only for an employer that says it's registered with the Fund (setup and Settings); a mutual association such as FEM instead isn't the Fund's | `tax.ts` `ROE_SEASONS` | [Notice 3894 of 2026 (GG 54524)](https://www.gov.za/sites/default/files/gcis_document/202604/54524gen3894.pdf), [Notice 4140 of 2026 (GG 55347)](https://www.gov.za/sites/default/files/gcis_document/202609/55347gen4140.pdf), [the 2025 extension, Notice 3200 of 2025](https://www.acts.co.za/compensation/n3200_notice_no__3200_of_2025) |

Home shows the same CIPC and return of earnings dates, five weeks ahead (`dashboard.ts` `taxDue`),
with whose return it is (SARS, CIPC or the Compensation Fund); CIPC's stays a month after it's due,
as one that was due. The return of earnings is shown only for a season that's in `ROE_SEASONS`:
none is guessed, and from April to July Home says when this year's isn't in Shap's tables yet. Each
standard update adds the Fund's next season once it's in the Gazette (usually in March or April):
from 1 May of the year after the last season's, the tests fail until it's in, and CI runs on 1 May
and each Monday in May.

### The cash-flow forecast's tax figures (Shap only, estimates)

The forecast (`apps/server/src/modules/forecast.ts`) puts SARS's payments in the weeks they're
due. Each is an estimate, said so on screen with who OpenWorks IT are:

- **VAT**: on the invoice basis (Shap's VAT201s are). A period's VAT is the VAT account's movement
  in it that isn't a payment or refund (an entry with a cash side) or an opening balance: journals
  by hand and books brought in count in their own period. What's owed for periods that have ended
  (the VAT account today, less this period's VAT and any payment already booked ahead): the last
  period's own on its `vat201Due` (this week when that's past), anything older this week. This
  period's, documents dated ahead in it included, on its own `vat201Due`. Always eFiling's date
  (the last business day), never the 25th. A vendor on the payments basis would owe less, sooner
  or later. A business no longer registered still has what's in its VAT account forecast.
- **EMP201**: those owed (`payrollAttention`) on their `emp201Due`; then each month after the later
  of the last pay run's pay month and its period (a run paid early isn't repeated), PAYE, UIF (both
  halves) and SDL as the middle of the last three runs, by the month paid, as SARS groups them.
  The employment tax incentive isn't taken off. A pay date more than a month from its run's month
  is refused (it would be taxed on the wrong tables and go on the wrong EMP201).
- **DTR01**: dividends tax owed, on its due date (`dwtDue`, from the day paid).
- Not in it: provisional tax and turnover tax (said on screen).

Home's debtor days are now measured against invoices as issued (their VAT in them), not grossed up
by `vatRateOn`.

Not shown: a filing season SARS hasn't announced yet, and a return of earnings season the Fund
hasn't announced yet.

## VAT

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| Standard rate 15% (from 1 April 2018; the 15.5% from 1 May 2025 was withdrawn), by date | `vat.ts` | all | [SARS: VAT rates](https://www.sars.gov.za/tax-rates/value-added-tax/), [KPMG Budget guide 2026](https://assets.kpmg.com/content/dam/kpmgsites/za/pdf/2026/02/SA%20Budget%20Guide%202026.pdf) |
| Registration: compulsory R1 million, voluntary R50 000; R2.3 million and R120 000 from 1 April 2026 | `tax.ts` `VAT_THRESHOLDS` | all | SARS Budget 2026 FAQ (above); not yet promulgated when checked |
| Categories A, B, C (two-monthly, monthly), D (six-monthly, February and August), E (yearly, at the year end) | `tax.ts` `vatPeriod` | all | [SARS: tax periods](https://www.sars.gov.za/types-of-tax/value-added-tax/tax-periods-for-vat-vendors/) |
| VAT201 due: last business day of the month after (eFiling), 25th by hand | `tax.ts` `vat201Due` | all | [SARS: obligations of a vendor](https://www.sars.gov.za/types-of-tax/value-added-tax/obligations-of-a-vat-vendor/) |
| Full tax invoice (the recipient's name, address and VAT number, s20(4)) over R5 000, or for anything zero-rated or exported (the abridged form "shall not apply to a supply that is charged with tax under section 11", proviso to s20(5)); the abridged tax invoice up to R5 000 (s20(5)); none needed at R50 or less paid in money (s20(6)) | `vat.ts` `needsFullTaxInvoice`, `documents.ts` `assertTaxDocument`, `sales.ts` `makeSale`, the books audit | all | [SARS: tax invoices](https://www.sars.gov.za/businesses-and-employers/tax-invoices/), [VAT Act s20](https://www.acts.co.za/value-added-tax-act-1991/20__tax_invoices), [VAT 404 §13](https://www.sars.gov.za/legal-pub-guide-vat404-vat-404-guide-for-vendors) |
| Every sale at the counter is a tax invoice (from 1.24), numbered with the other invoices; only a VAT vendor issues a tax invoice (s20(1)), so a business not registered says "Invoice" | `sales.ts`, `pdf.ts` | all | VAT Act s20 (above) |
| One tax invoice per supply; a copy marked "copy" (provisos to s20(1)); a walk-in's details added afterwards go on the same invoice and number, which then says it replaces the abridged one (s20(1B): corrected within 21 days of the request) | `sales.ts` `addSaleCustomer`, `pdf.ts` `fullAfterwards` | all | VAT Act s20 (above) |
| Credit notes: the reason, the invoice credited (s21(3)); a walk-in's short slip from before 1.24 gets as short a credit note | `documents.ts` `assertTaxDocument` | all | [VAT Act s21](https://www.acts.co.za/value-added-tax-act-1991/21__credit_and_debit_notes) |
| Records kept five years (s55, Tax Administration Act s29): issued documents are never deleted; a reopened month is in the audit log | `periods.ts`, the audit log | all | [VAT Act s55](https://www.acts.co.za/value-added-tax-act-1991/55__records) |
| A filed VAT201 is corrected by a revised return; input tax isn't increased by revising a past period (it's claimed in a later one, within five years): Locks says so when a reopen opens an ended VAT period | `periods.ts` `vatPeriodsReopened`, `Locks.tsx` | all | [SARS: request for correction](https://www.sars.gov.za/individuals/what-if-i-do-not-agree/request-for-corrections/), [VAT201 guide](https://www.sars.gov.za/gen-elec-04-g01-guide-for-completing-the-value-added-tax-vat201-declaration-external-guide) |
| A tourist taking goods home is charged 15% (not zero-rated as an export); they claim it back from the VAT Refund Administrator | the docs (SALES_AND_STOCK.md) | all | [SARS: VAT refunds for tourists](https://www.sars.gov.za/types-of-tax/value-added-tax/vat-refunds-for-tourists-and-foreign-enterprises/) |
| Bad debts (s22(1)): output VAT back at the invoice's rate | the ledger, `books.ts` | all | [VAT Act s22](https://www.acts.co.za/value-added-tax-act-1991/22__irrecoverable_debts) |
| An amount paid in a client's name as its agent and recovered at cost is no supply by the one who paid it (a supply to an agent is made to its principal, s54(2)): the "Exempt or not a supply" option's hint says it's generally neither the business's supply nor its revenue, and as Shap counts every invoice line as revenue, to leave it off Shap's invoices, and an accounting practice is offered no invoice item for it (an invoice line is revenue: docs/ACCOUNTANT.md) | `vat.ts`, `industry.ts` (accounting) | all | [VAT Act s54](https://www.acts.co.za/value-added-tax-act-1991/54__agents_and_auctioneers) |

## Payroll

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| PAYE: the individual tables (above), annualised | `payroll.ts` (shared) | 2023 to 2027 | SARS: rates for individuals (above) |
| Medical scheme fees credits | `payroll.ts` `MEDICAL_CREDITS` | 2023 to 2027 | [SARS: medical tax credits](https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/) |
| UIF 1% + 1%, ceiling R17 712 a month | `payroll.ts` `UIF_CEILING_CENTS` | all | [SARS: UIF](https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/) |
| SDL 1% above R500 000 a year | `payroll.ts` `SDL_RATE`, `SDL_THRESHOLD_CENTS` | all | [SARS: SDL](https://www.sars.gov.za/types-of-tax/skills-development-levy/) |
| EMP201 by the 7th (earlier on a weekend or holiday); EMP501 interim September/October, annual April/May | `payroll.ts` `emp201Due`, EMP501 | all | [EMP501 interim 2026](https://www.sars.gov.za/latest-news/employer-interim-declarations-emp501-21-september-to-october-2026/), [SMME Connect 14](https://www.sars.gov.za/businesses-and-employers/small-businesses-taxpayers/smme-connect-issue-14-april-2026/) |
| IRP5 codes (3601, 3605–3607, 3699, 4102, 4141, 4142…) | `payroll.ts` (server) | all | [SARS employers' guide 2027](https://www.sars.gov.za/guide-for-employers-in-respect-of-employees-tax-2027/) |

### Day labour (Workers: reminders only, docs/CASUAL_LABOUR.md)

Shap doesn't work out PAYE, UIF or SDL on day wages: these are the figures its reminders rely on.
Checked 11 November 2026.

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| Standard employment: 22 hours a week or more for one employer; deemed: at least 5 hours a day for under R394 a day (2026/27), or a written declaration of no other employer; otherwise 25% | `labour.ts` `DEEMED_STANDARD_DAY`, `casualLabourNote` | 2027 (tied to `SARS_CHECKED_TO`) | [SARS: guide for employers 2027](https://www.sars.gov.za/paye-gen-01-g21-guide-for-employers-iro-employees-tax-for-2027-external-guide/) |
| UIF from 24 hours a month with one employer (UICA s4(1)(a)) | `labour.ts` `LAW_HOURS_A_MONTH` | all | [UICA s4](https://source.acts.co.za/unemployment-insurance-contributions-act-2002/4__application_of_act.php) |
| The national minimum wage: R28.79 from 1 March 2025, R30.23 from 1 March 2026 (not SARS's: the Department of Employment and Labour's, checked with these each year) | `labour.ts` `NATIONAL_MINIMUM_WAGE` | 2026, 2027 | [GN R.7083](https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf) |
| SDL counts day wages with salaries (Home's warning) | `payroll.ts` (server) `sdlLine` | all | [SARS: SDL](https://www.sars.gov.za/types-of-tax/skills-development-levy/) |

## Dividends

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| Dividends tax 20% (from 22 February 2017), exemptions, due by the end of the month after; DTR01 and a DTR02 per shareholder | `payroll.ts` `DWT_RATE_BP`, `dwtDue` | all | [SARS: dividends tax](https://www.sars.gov.za/types-of-tax/dividends-tax/) |
| A micro business on turnover tax: the first R200 000 of dividends a year, all shareholders together, free of dividends tax (s64F(1)(h)) | `payroll.ts` `MICRO_DIVIDEND_EXEMPT_CENTS`, `microDividendTax` | all | [SARS: dividends tax exemptions](https://www.sars.gov.za/faq/faq-are-there-any-exemptions-applicable-to-dividends-tax/), [TT01 guide](https://www.sars.gov.za/legal-pub-guide-tt01-tax-guide-for-micro-businesses) |

## Not modelled (the accountant's)

- Provisional tax underestimation penalties (the 80% and 90% rules, the basic amount).
- VAT s22(3): input tax repaid on bills still unpaid 12 months after the period.
- The employment tax incentive (ETI).
- VAT category F (four-monthly, VAT Act s27(4B): SARS offers A to E only) and tax periods ending on
  a fixed day within 10 days of a month end (s27(6) proviso; Interpretation Note 52): Shap's VAT
  periods end on month ends.
- PAYE, UIF and SDL on day wages (Workers): Shap reminds, the business works them out.
- A "VAT claimed on" date for a supplier invoice claimed in a later period (s16(3)): the cost keeps
  its own date, and the VAT goes in the period it's dated in.
- Capital gains (the inclusion rate) and non-deductible items (fines, s23(o)) in the income tax
  estimate.
- Individual tables before the 2023 year (earlier years use 2023's), medical credits before the
  2023 year (2023's), and SBC tables before the year ending 1 April 2020 (2021's).
- The travel logbook's rate per km (Shap keeps the trips, not a claim).
- A direction from SARS under s20(7) (another document in place of a tax invoice).
- Proof of export (s11(3)): the documents are the vendor's to keep.
- Marking a reprint of an issued tax invoice "copy".
- Tax allowances in place of depreciation: wear and tear (s11(e)), and a small business
  corporation's write-off of plant (s12E(1), (1A)). The estimates take the profit in the books.
- A year shorter than twelve months (a new company's first year): SARS scales the SBC table (the
  proviso to s12E(4)); the estimate doesn't.
- Special trusts (taxed at the individual tables) and a trust's beneficiaries' tax.
- Books brought in from another package (docs/ACCOUNTANT.md): a VAT201 or payroll worked out
  there. A VAT period whose VAT came in from the package is marked on the VAT201 screen and in the
  tax pack ("From another package") and left out of the books audit's VAT check; PAYE journals
  brought in are counted apart from journals by hand. The estimates project from the last day
  brought in. A trust's distributions in the books brought in are shown, not taken off (s25B:
  which part is this year's income to residents is the accountant's to work out). A dividend in a
  ledger brought in lists its dividends tax return on the practice list; one inside a trial
  balance can't (it has no day of its own).
- A sole proprietor's estimate leaves out the medical credits and the interest exemption; payroll
  has the credits.
- VAT category D ending in months other than February and August, and E at a month other than the
  year end (both on written application to SARS).
