# Annual financial statements

Switched on in setup ("Should Shap draw up your annual financial statements?") or later under
**Settings → What you use → Money and tax**. Leave it off when the accountant prepares the
statements in their own software from what Shap gives them (the accountant's export, the trial
balance). They're under **Accounts → Financial statements**.

## What's in the set

Drawn up from the books under the **IFRS for SMEs Accounting Standard**, with the
Companies Act 71 of 2008 for companies. https://www.ifrs.org/issued-standards/ifrs-for-smes/

- a cover, contents and general information (registration, tax and VAT numbers, address,
  bankers, the compiler);
- the directors' (members', trustees', owner's) responsibilities and approval, and their report
  (Companies Act s30(3)(b): the nature of the business, the results, share capital,
  distributions, the directors, events after the reporting period, going concern, assurance);
- the compiler's report (ISRS 4410 (Revised)), once compiled;
- the **statement of financial position** (current and non-current, section 4), **of
  comprehensive income** (one statement, expenses by function with cost of sales apart, section 5), **of changes in equity**
  (section 6) and **of cash flows** (indirect method, section 7), each with last year's figures
  beside this year's (3.14);
- the notes: the basis of preparation and accounting policies first (section 8), then a note for
  each line that needs one (property, plant and equipment with its reconciliation 17.31,
  intangibles, inventories 13.22, receivables, payables, loans and their terms, tax, related
  parties section 33, events after the reporting period 32);
- a detailed income statement, account by account (not part of the IFRS set: for the owners and
  SARS).

A sole proprietor or partnership gets the same statements with its owners' words (the owner's
capital, drawings, no income tax provided: the profit is taxed in the owners' hands).

## Where each account goes

Every account has a **line on the statements** (Settings → Chart of accounts → an account → On the
financial statements), chosen by Shap from the account's kind and system role and changeable to
any line that fits its type. Lines are grouped into current and non-current. A balance that turns
the other way at year end moves across by itself: a bank account in overdraft shows as a bank
overdraft under current liabilities, a loan to a shareholder under current assets, a VAT refund
due under receivables. Loans from the owners with no fixed terms of repayment start as current
liabilities (repayable on demand, IFRS for SMEs 4.7(d)): if the lenders have agreed in writing
not to call them within twelve months, move the account to non-current and say so in the loan
terms. Invoice and sale lines of every kind are revenue (other income is for what isn't trade,
such as a profit on selling an asset). Shap's own accounts keep their lines (`packages/shared/src/statement-lines.ts`,
and the same rules in the database, `apps/server/migrations/038_statement_lines.sql`).

## The checks

The draft is always built from the books as they are. Before it can be signed:

- the statement of financial position balances, this year and last;
- the cash flow statement ends at the cash shown (it's built from the movement of every account
  that isn't cash, so it ties by construction, and this proves it);
- the statement of changes in equity ends at the equity shown;
- nothing is left in suspense;
- the books audit finds nothing to fix (its warnings are shown, not stopping anything).

## From draft to signed

| Step | Full Shap | Shap Pocket |
| --- | --- | --- |
| The wording | Owner or accountant: the directors, nature of the business, addresses, bankers, the compiler, going concern, events after the reporting period; each accounting policy has Shap's wording for the business, replaced by anything typed (a blank one keeps Shap's) | Owner |
| To the accountant | Emailed with the draft PDF attached (it goes to the address the owner types), or shared or downloaded | Shared from the phone (WhatsApp, email) |
| Compiled | The accountant, signed in to Shap as themselves, signs the compiler's report; or the owner uploads the report the accountant signed on paper (or as a PDF) | The owner uploads the signed report |
| Approved | The owner signs as director (member, trustee…) | The same |

A sole proprietor's or partnership's statements say the owner's (partners') words, report drawings
as drawings, provide no income tax, and are prepared on the basis of accounting note 1 describes
(the recognition and measurement principles of the IFRS for SMEs Accounting Standard), which the
compiler's report then names. A company's tax note explains the tax expense against the profit at
the company rate.

When compiled, the figures are **frozen**: the set is kept exactly as signed, with a hash of its
figures, and the PDF says FOR APPROVAL until it's approved (DRAFT before it's compiled). Approving checks that the books still give exactly those figures (if anything dated in
the year changed since, it's refused: reopen and send it again). Approving **agrees the year end**
at those figures (Accounts → Year end), **closes the year** (nothing more can be posted into it),
and keeps the signed PDF on file. Each step is in the audit log.

**Reopen** (the owner, with a reason) takes the statements back to a draft. An approved year stays
closed: its lock date can't be moved back while the statements stand approved, and after
reopening only by moving it (Accounts → Year end), which is in the audit log too.

## What to check by hand

- The cash flow statement is built from how every other account moved, so it ties to the cash by
  construction. An asset bought on account (a bill) or with the owner's own money isn't a cash
  flow (IFRS for SMEs 7.18), but shows here as an investing outflow with the matching payable or
  loan in operating or financing: the accountant moves it out if it's material.
- A close corporation also needs its accounting officer's report (Close Corporations Act s62);
  the accountant provides it with the compilation.
- Shap doesn't work out the public interest score that decides whether a company needs an audit
  or an independent review.

## Assurance

A company whose every shareholder is also a director is exempt from audit and independent review
(Companies Act s30(2A)), so a compilation is enough unless its public interest score says
otherwise (Companies Regulations 26 to 29). Shap says on the statements which assurance they carry;
it doesn't work out the public interest score.
https://www.acts.co.za/companies-act-2008/30_annual_financial_statements
