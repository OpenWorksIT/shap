# The IFRS for SMEs check

Shap and Shap Pocket keep the books and draw up the annual financial statements under the **IFRS
for SMEs Accounting Standard**: the 2015 edition for years beginning before 1 January 2027, the third
edition (2025) after that (the statements name which, and the general information names the legal form).
https://www.ifrs.org/issued-standards/ifrs-for-smes/

This is the check of every decision the books and the statements make against the standard, section
by section, done for 1.23 and again for 1.24 (both apps share the accounting code). Each line says what Shap does, and
where the standard leaves something to judgement Shap can't make from the books, what it asks the
accountant to look at instead: the statements list those under **For your accountant to look at**,
never stopping the signing. **Fixed in 1.23** marks what the check changed, each with a test
(`apps/server/test/ifrs-check.test.ts`).

Shap is a record-keeping tool from OpenWorks IT, who are not accountants: everything it works out
under tax or company law is an estimate for the business and its accountant to check (the terms of
use, and the note under every such figure).

| Section | What the standard asks | What Shap does |
| --- | --- | --- |
| 2 Concepts | Accrual basis; prudence without bias | Accrual throughout: invoices on their date, costs on theirs, bills owed until paid, wages earned until paid, depreciation monthly. |
| 3 Presentation | A complete set, comparatives, going concern, compliance stated; the entity's domicile, legal form and registered office (3.24) | The four statements, notes, comparatives (3.14), going concern from the directors' wording. **Fixed in 1.23**: the legal form (limited liability, personal liability for an Inc, personally liable owners) and the edition of the standard. |
| 4 Financial position | Current and non-current; minimum lines; share capital particulars (4.12) | Each account on a line, current or non-current, flipping sides when a balance turns (an overdraft, a VAT refund, a loan to a shareholder). Owners' loans with no fixed repayment terms are current (4.7(d)). The share capital note is typed in (authorised, issued, par value). |
| 5 Comprehensive income | One statement; expenses by function or nature; by function, depreciation and employee benefits disclosed (5.11) | One statement, by function (cost of sales apart); the operating profit note gives depreciation, employee costs, directors' pay, rent and bad debts. |
| 6 Changes in equity | Profit, distributions, shares issued | From the books, shares issued on a row of their own. |
| 7 Cash flows | Indirect method; interest paid and received shown separately (7.14); tax paid (7.17); non-cash investing and financing left out and disclosed (7.18) | Built from how every other account moved, so it always ends at the cash. **Fixed in 1.23**: interest paid and received on lines of their own (in operating activities); assets paid personally by an owner, financed by a loan, or bought on a bill unpaid at the year end left out of investing (a bill is an investing outflow when it's paid) and told in a note; so is a bill for an asset the owner paid personally, or that a supplier's credit note took off (only money paid is an outflow). The VAT on such an asset stays in working capital. |
| 8 Notes | Basis, policies, judgements (8.6), estimation uncertainty (8.7) | Shap words each policy for the business (changeable), judgements included. |
| 10 Policies, estimates, errors | Changes in estimates prospectively; errors restated | Useful lives change going forward. A closed month or year is reopened with the reason, in the audit log, and locked again (docs/LOCKS.md); a signed year only once its statements are reopened, and the signed set is kept as it was (10.21: the error corrected openly). How to correct an issued set (restating the comparatives next year, or reissuing) is the accountant's. |
| 11 Basic financial instruments | Receivables and payables at the undiscounted amount; impairment when there's objective evidence (11.21) | So measured. A delinquent invoice is written off as a bad debt (with its VAT relief). **Fixed in 1.23**: invoices more than a year overdue at the year end are listed for the accountant to look at. Owners' interest-free loans repayable on demand at the amount payable. |
| 13 Inventories | Cost (purchase, non-recoverable taxes, less discounts); a cost formula (weighted average allowed, 13.18); service providers' work in progress at cost (13.14, 2015 edition); written down to selling price less costs to sell (13.19, 27.2); disclosures (13.22) | Weighted average cost; VAT that can't be claimed is cost; counts and losses into cost of sales. Jobs' costs wait in work in progress until invoiced. **Fixed in 1.23**: stock is written down to what it will sell for (Inventory → Valuation; on or after the day it last moved, since the average cost runs in the order stock moves, so stock that has moved since the year end is a journal at the year end), and stock carried above its selling price at the year end is listed. A supplier's discount beyond the claims it settles goes to cost of sales (on stock still on hand it would strictly reduce its cost: immaterial unless large). |
| 17 Property, plant and equipment | Cost model; depreciation over useful life to residual value; reconciliation (17.31) | Cost less depreciation, straight-line over the life the business sets (Shap's defaults are starting points, not SARS's wear-and-tear periods), to a residual value; disposals at their carrying amount; the reconciliation for both years. Components (17.16) and impairment (27) are the accountant's. |
| 18 Intangibles | Amortised; 10 years when the life can't be estimated (18.20) | Amortised straight-line; patents default to 10 years. |
| 20 Leases | Operating lease payments straight-line (20.15) | Rent as charged. An escalating lease that should be straight-lined is the accountant's journal. |
| 21 Provisions | A present obligation, probable, reliably measured | Provision lines are there for the accountant's journals. |
| 22 Equity | Shares at the amount received; distributions when declared | So. |
| 23 Revenue | Goods when control passes (risks and rewards, 2015); services as performed | A sale at the counter when sold; an invoice when issued. **Fixed in 1.23**: the policy says so plainly (services are invoiced as the work is done, and work not yet invoiced is work in progress at cost), and work in progress at the year end is listed for the accountant (a job that will make a loss, or work done but not invoiced). |
| 24 Government grants | Income when the conditions are met | Not modelled: the accountant's. |
| 25 Borrowing costs | Expensed | Interest is an expense (finance costs). |
| 27 Impairment | Inventories at selling price less costs to sell; other assets when impaired | Inventories as in 13. Other assets: the accountant's. |
| 28 Employee benefits | Short-term benefits as the service is rendered, accumulated leave and bonuses owed accrued (28.6, 28.8) | Salaries, UIF and SDL in the month. **Fixed in 1.23**: with employees on payroll, leave pay and bonuses owed at the year end are listed for the accountant (Shap doesn't keep leave balances). |
| 29 Income tax | Current tax on the year's taxable profit; deferred tax on temporary differences | **Fixed in 1.23**: a company (or trust, or taxed NPC) with no tax booked for the year is listed for the accountant, with Shap's estimate (the profit less any assessed loss, at the company rate or the small business corporation rates if the business said it qualifies for that year, both figures until it's said, the SBC table left out above R20 million of gross income; a trust's less what it gave its beneficiaries, up to the year's income). The assessed loss is each earlier year's loss carried forward and used only by later profits, a company's set-off limited to the greater of R1 million and 80% of its taxable income for years ending on or after 31 March 2023 (Income Tax Act s20(1)(a)(ii)), and it can be booked with one tap (a journal: income tax against tax owed). **1.23.2**: also listed when the tax booked is far from the estimate; not for a company on turnover tax, or where the year (or a later one) is agreed or closed. Deferred tax lines are there for the accountant's journal: the tax note gives the current tax and reconciles the whole expense to the profit at the company rate (both years' rates where they differ, 29.41(d)), the SBC rates on a line of their own when the tax booked is on that table, and says when an assessed loss is carried forward. It doesn't split the expense into current and deferred tax, or reconcile a trust's distributions on a line of its own: the accountant's, where they matter. |
| 30 Foreign currency | Translated at the transaction date | Shap records in rand only. |
| 32 Events after the reporting period | Adjusting or disclosed; dividends declared after the year end aren't a liability | The directors' wording; dividends by their declaration date. |
| 33 Related parties | Key management compensation in total (33.7); transactions and balances | The directors (members, trustees…), their pay, their loans, distributions declared. |
| 35 Transition | A first set under the standard explains the transition | A business that reported under another framework before: the accountant's. |

## South African law

| | What's required | What Shap does |
| --- | --- | --- |
| Companies Act s29, s30 | Statements under the framework the regulations prescribe, approved by the board | The directors' responsibilities, report and approval; signed in Shap. |
| Companies Act s24, s28; Tax Administration Act s29, s30 | Accurate and complete records, kept in their original form; the statements seven years, records five | Issued invoices (a sale's too), credit notes and refunds are never changed or deleted; locks keep closed periods as they were; a reopen and its reason are in the audit log; a reopened signed set is kept with its PDF. 1.24 made the old sales invoices without changing what they were issued as (their numbers, dates, amounts, terms). |
| Public interest score (Companies Regulations 26 to 29) | The score each year; an audit (28), an independent review (29), or exempt (s30(2A)) | **New in 1.23**: Shap works out the score from the books (employees from payroll and the days logged, subcontractors left out; liabilities, turnover, shareholders or members) and says what it points to, as an estimate. An audit the statements don't have, or a review they need, is listed for the accountant. A company that must be audited also discloses each director's remuneration (s30(4) to (6)): Shap's statements don't break it out, so that's for the auditor and the accountant. |
| Close Corporations Act s58, s62 | The accounting officer's report with the statements; insolvency reported to CIPC (s62(3)); loans to members need all members' consent (s52) | **New in 1.23**: a close corporation's statements carry the accounting officer's report (SAICA's wording), signed in Shap or uploaded; members' interest in deficit and loans to members are listed for the accountant. |
| Co-operatives Act | Its own statements and audit rules | The statements name the Act; the co-op's audit is the accountant's. |

## Known limits (for the accountant)

- The cash flow leaves the VAT on an asset bought without cash in working capital.
- Shap doesn't keep leave balances, straight-line escalating leases, split components, or work out
  deferred tax: each is a journal when it's material.
- The public interest score's employees are an average of the people paid or logged each month;
  whether loans from the owners count as third-party liabilities is the accountant's reading
  (Shap counts every liability, and shows the owners' loans apart).
