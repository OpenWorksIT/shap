# Goalposts: what's being worked on

The development list behind the website's goalposts page
([openworks.co.za/shap/goalposts](https://openworks.co.za/shap/goalposts/)): what's next, what's
further off, and what isn't planned, each with how hard it looks and why. Keep the two in step:
when something here ships or moves, the page moves with it (and the site's FAQ, "What are you
working on next?"). These are intentions, not promises, and there are no dates.

How hard, roughly:

- **Low**: fits what Shap already has (its tables, screens and checks), a few days.
- **Medium**: something new in the books or a new rule to get right, with its own reviews; a week or
  two.
- **High**: changes how the books, stock or the apps are built underneath; weeks, and it touches
  most of the CPD reviews.

Started from the gaps people and chatbots (ChatGPT, Gemini) named in November 2026, less what Shap
already does.

## Done

| What | Version | How hard it was |
| --- | --- | --- |
| Bank statements as OFX (and QFX) and QIF as well as CSV; rules that fill in a line ("lines that say ENGEN are Petrol") | 1.33 | Low: the reconciliation was there; two parsers and a table of rules |
| Scanning barcodes with the phone's camera (Chrome for Android; a scanner or typing works everywhere) | 1.33 | Low: the browser's own BarcodeDetector, on the phone, nothing sent anywhere |
| Home: money in the bank and till, what the cards owe, debtor and creditor days, the gross margin month by month | 1.33 | Low: figures the books already had |
| CIPC annual return and the Compensation Fund's return of earnings on Home and the practice's list | 1.33 | Low: a date and a yes/no in setup and Settings; the Fund's season added each year (CPDAUDIT.md section 2) |
| A 13-week cash-flow forecast | 1.33 | Medium: from invoices, bills, payroll, day wages, VAT and the monthly costs already found |
| Budgets, month by month, against actual | 1.33 | Medium: a new table and screen; the actuals are the income statement's |

## Next

| What | How hard | Why |
| --- | --- | --- |
| Progress claims and retention, for contractors | Medium | Jobs and quotes are there. A claim in stages against the quote, and the retention a client holds back as a debtor of its own until it's released, need a new kind of invoice, an account, and the VAT timing for retention checked with the SARS review |
| Approvals: supplier bills over an amount the owner sets wait for the owner | Low to medium | Bills, roles and access tasks are there; an approval state, a threshold in Settings, and who may approve |
| Leave balances in payroll | Medium | Annual and sick leave under the BCEA's cycles, shown on the payslip, and leave pay owed at the year end as a liability in the books (a short-term compensated absence) |
| Purchase orders, turned into supplier invoices when the stock arrives | Medium | Supplier invoices with short supplied are there; an order of its own, in its own numbers, received in part or in full |
| Stock records in Shap Pocket | Medium | The accounting code is shared; the screens and the weighted average cost on the phone, with the same audit |
| A wear-and-tear schedule beside the books' depreciation, as an estimate | Medium | SARS's allowances (s11(e) at Interpretation Note 47's rates, s12C, a small business corporation's s12E) are a table to keep current each year, and each asset's tax value; an estimate for the tax practitioner, like the other tax figures |
| The iPhone app for Shap Pocket | Medium | The iOS build runs in CI already; what's left is mostly Apple's: the developer account, App Store review and the privacy details |

## Further off

| What | How hard | Why |
| --- | --- | --- |
| Several stock locations, and serial and lot numbers | High | Changes the stock model everywhere: cost, transfers and stock takes by location, and each unit's history |
| Foreign currency | High | Each invoice and bill in its own currency, the rand amount at the rate of the day for the books and VAT, and exchange differences when it's paid and at the year end |
| A report builder | High | A general way to ask the books anything, safely, for every role. Until then, the CSV exports open in a spreadsheet |
| Manufacturing: bills of materials and production runs | High | Work in progress and the cost of what's made, on top of the stock model |
| Syncing Shap Pocket between devices | High | Pocket has no server, and nothing personal leaves the phone without the owner's yes: syncing needs a way that keeps that (the owner's own Shap, or encrypted end to end) and merges two phones' books |
| Group reporting for related companies | High | Consolidating companies that each have their own database, and taking out what they sell each other |

## Not planned, and why

| What | Why |
| --- | --- |
| Live bank feeds | They usually go through paid third parties or an agreement with each bank, and the bank data would pass through someone else. That goes against Shap being free and the books being in the owner's hands. Importing the statement file does the same job |
| Filing returns on SARS eFiling for the business | Shap prepares the figures and exports; the owner or their tax practitioner files them. Filing on someone's behalf would make OpenWorks IT part of their tax affairs, which a free tool shouldn't be (and the wording rule: OpenWorks are not accountants or tax practitioners) |
