# The SARS register

Every tax and SARS figure Shap and Shap Pocket work with: where it lives in the code, SARS's own
page for it, the years it covers, and when it was last checked. The SARS review (CPDAUDIT.md)
works through this list on every update, and it's where to start when SARS changes something.

The code keeps tables by year: a table applies to years of assessment ending on or after its
`from`, so an unchanged year needs no new row. `SARS_CHECKED_TO` (`packages/shared/src/tax.ts`) is
the last year of assessment checked against SARS: from the day after, CI fails until the next
year's figures are checked and put in (the standard update, CPDAUDIT.md).

Everything here is in the shared code, so it is the same in Shap Pocket.

**Checked up to the year ending 28 February 2027 (2026/27), on 10 November 2026.**

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
| Provisional tax (IRP6): first period half the year's tax, second the rest, less what's been paid (the payments recorded for the year). The screen works out the amount; SARS's due dates (the end of the sixth month and the year end) are in the guide, not on the screen | `tax.ts` `provisionalPayable`, the IRP6 screen | all | [SARS guide to provisional tax](https://www.sars.gov.za/guide-to-provisional-tax/) |
| Turnover tax: tables and the micro business limit (R1 million, R2.3 million from the year ending February 2027); TT02 payments end August and end February; TT03 1 July to 31 January | `tax.ts` `TURNOVER_TABLES`, `turnoverTaxLimit` | 2022 to 2027 | [SARS: turnover tax rates](https://www.sars.gov.za/tax-rates/turnover-tax/), [turnover tax](https://www.sars.gov.za/types-of-tax/turnover-tax/) |
| A company on turnover tax needs a February year end | `settings.ts` | until the Budget 2026 proposal is law | [TT01 FAQ](https://www.sars.gov.za/legal-pub-faqs-tt01-faqs-on-turnover-tax); watch: the [Budget 2026 FAQ](https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/) proposes dropping it |
| Filing seasons (ITR12, ITR14, ITR12T) shown in the guides | `Guides.tsx` | 2026 season | [SARS filing season 2026](https://www.sars.gov.za/filing-season-2026-leaflet/) |

## VAT

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| Standard rate 15% (from 1 April 2018; the 15.5% from 1 May 2025 was withdrawn), by date | `vat.ts` | all | [SARS: VAT rates](https://www.sars.gov.za/tax-rates/value-added-tax/), [KPMG Budget guide 2026](https://assets.kpmg.com/content/dam/kpmgsites/za/pdf/2026/02/SA%20Budget%20Guide%202026.pdf) |
| Registration: compulsory R1 million, voluntary R50 000; R2.3 million and R120 000 from 1 April 2026 | `tax.ts` `VAT_THRESHOLDS` | all | SARS Budget 2026 FAQ (above); not yet promulgated when checked |
| Categories A, B, C (two-monthly, monthly), D (six-monthly, February and August), E (yearly, at the year end) | `tax.ts` `vatPeriod` | all | [SARS: tax periods](https://www.sars.gov.za/types-of-tax/value-added-tax/tax-periods-for-vat-vendors/) |
| VAT201 due: last business day of the month after (eFiling), 25th by hand | `tax.ts` `vat201Due` | all | [SARS: obligations of a vendor](https://www.sars.gov.za/types-of-tax/value-added-tax/obligations-of-a-vat-vendor/) |
| Full tax invoice over R5 000 | documents, sales | all | [SARS: tax invoices](https://www.sars.gov.za/businesses-and-employers/tax-invoices/) |
| Bad debts (s22(1)): output VAT back at the invoice's rate | the ledger, `books.ts` | all | [VAT Act s22](https://www.acts.co.za/value-added-tax-act-1991/22__irrecoverable_debts) |

## Payroll

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| PAYE: the individual tables (above), annualised | `payroll.ts` (shared) | 2023 to 2027 | SARS: rates for individuals (above) |
| Medical scheme fees credits | `payroll.ts` `MEDICAL_CREDITS` | 2023 to 2027 | [SARS: medical tax credits](https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/) |
| UIF 1% + 1%, ceiling R17 712 a month | `payroll.ts` `UIF_CEILING_CENTS` | all | [SARS: UIF](https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/) |
| SDL 1% above R500 000 a year | `payroll.ts` `SDL_RATE`, `SDL_THRESHOLD_CENTS` | all | [SARS: SDL](https://www.sars.gov.za/types-of-tax/skills-development-levy/) |
| EMP201 by the 7th (earlier on a weekend or holiday); EMP501 interim September/October, annual April/May | `payroll.ts` `emp201Due`, EMP501 | all | [EMP501 interim 2026](https://www.sars.gov.za/latest-news/employer-interim-declarations-emp501-21-september-to-october-2026/), [SMME Connect 14](https://www.sars.gov.za/businesses-and-employers/small-businesses-taxpayers/smme-connect-issue-14-april-2026/) |
| IRP5 codes (3601, 3605–3607, 3699, 4102, 4141, 4142…) | `payroll.ts` (server) | all | [SARS employers' guide 2027](https://www.sars.gov.za/guide-for-employers-in-respect-of-employees-tax-2027/) |

## Dividends

| Figure | Where | Years | Source |
| --- | --- | --- | --- |
| Dividends tax 20% (from 22 February 2017), exemptions, due by the end of the month after; DTR01 and a DTR02 per shareholder | `payroll.ts` `DWT_RATE_BP`, `dwtDue` | all | [SARS: dividends tax](https://www.sars.gov.za/types-of-tax/dividends-tax/) |
| A micro business on turnover tax: the first R200 000 of dividends a year, all shareholders together, free of dividends tax (s64F(1)(h)) | `payroll.ts` `MICRO_DIVIDEND_EXEMPT_CENTS`, `microDividendTax` | all | [SARS: dividends tax exemptions](https://www.sars.gov.za/faq/faq-are-there-any-exemptions-applicable-to-dividends-tax/), [TT01 guide](https://www.sars.gov.za/legal-pub-guide-tt01-tax-guide-for-micro-businesses) |

## Not modelled (the accountant's)

- Provisional tax underestimation penalties (the 80% and 90% rules, the basic amount).
- VAT s22(3): input tax repaid on bills still unpaid 12 months after the period.
- The employment tax incentive (ETI).
- Capital gains (the inclusion rate) and non-deductible items (fines, s23(o)) in the income tax
  estimate.
- Individual tables before the 2023 year (earlier years use 2023's), medical credits before the
  2023 year (2023's), and SBC tables before the year ending 1 April 2020 (2021's).
- The travel logbook's rate per km (Shap keeps the trips, not a claim).
- Tax allowances in place of depreciation: wear and tear (s11(e)), and a small business
  corporation's write-off of plant (s12E(1), (1A)). The estimates take the profit in the books.
- A year shorter than twelve months (a new company's first year): SARS scales the SBC table (the
  proviso to s12E(4)); the estimate doesn't.
- Special trusts (taxed at the individual tables) and a trust's beneficiaries' tax.
- A sole proprietor's estimate leaves out the medical credits and the interest exemption; payroll
  has the credits.
- VAT category D ending in months other than February and August, and E at a month other than the
  year end (both on written application to SARS).
