# Annual financial statements

Switched on in setup ("Should Shap draw up your annual financial statements?") or later under
**Settings → What you use → Money and tax**. Leave it off when the accountant prepares the
statements in their own software from what Shap gives them (the accountant's export, the trial
balance). They're under **Accounts → Financial statements**.

## What's in the set

Drawn up from the books under the **IFRS for SMEs Accounting Standard** (the 2015 edition for years
beginning before 1 January 2027, the third edition after: the statements say which), with the
Companies Act 71 of 2008 for companies. https://www.ifrs.org/issued-standards/ifrs-for-smes/
docs/IFRS.md is the section-by-section check of what Shap does against the standard.

- a cover, contents and general information (the legal form, registration, tax and VAT numbers,
  address, bankers, the compiler);
- the directors' (members', trustees', owner's) responsibilities and approval, and their report
  (Companies Act s30(3)(b): the nature of the business, the results, share capital,
  distributions, the directors, events after the reporting period, going concern, assurance);
- the compiler's report (ISRS 4410 (Revised)), once compiled; for a close corporation, the
  accounting officer's report (Close Corporations Act s62, in the words of SAICA's guide);
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

**For your accountant to look at** (shown with the checks, never stopping the signing): what the
standard asks that the books alone can't settle.

- the year's income tax (a company, trust or taxed NPC): none booked, Shap shows its estimate
  (the profit less any assessed loss, at the company rate, or the small business corporation rates
  if the year's last provisional estimate said so) and books it with one tap, as a journal (income
  tax against tax owed) the accountant can change;
- stock carried above what it will sell for (write it down: Inventory → Valuation);
- work in progress at the year end (a job that will make a loss; work done but not invoiced);
- invoices more than a year overdue (write them off if they won't be paid);
- with employees on payroll: leave pay and bonuses owed at the year end;
- the assurance the public interest score asks for, if the statements don't have it;
- a close corporation: members' interest in deficit (the accounting officer reports it to CIPC,
  s62(3)), and loans to members (all members' written consent, s52).

## From draft to signed

| Step | Full Shap | Shap Pocket |
| --- | --- | --- |
| The wording | Owner or accountant: the directors, nature of the business, addresses, bankers, the compiler, going concern, events after the reporting period; each accounting policy has Shap's wording for the business, replaced by anything typed (a blank one keeps Shap's) | Owner |
| To the accountant | Shared with the accountant (the draft PDF and a short note, from the phone or computer's share, or downloaded), or emailed from Shap when the server sends email | Shared from the phone (WhatsApp, email) |
| Compiled | The accountant, signed in to Shap as themselves, signs the compiler's report (a CC's accounting officer, their s62 report); or the owner uploads the report the accountant signed on paper (or as a PDF) | The owner uploads the signed report |
| Approved | The owner signs as director (member, trustee…) | The same |

A sole proprietor's or partnership's statements say the owner's (partners') words, report drawings
as drawings, provide no income tax, and are prepared on the basis of accounting note 1 describes
(the recognition and measurement principles of the IFRS for SMEs Accounting Standard), which the
compiler's report then names. A company's tax note explains the tax expense against the profit at
the company rate.

When compiled, the figures are **frozen**: the set is kept exactly as signed, with a fingerprint
of the books it was drawn from (each account's figures for both years: from 1.23, so a later Shap
that draws the same books differently doesn't make a signed set look changed; a set signed before
1.23 is compared by its four statements), and the PDF says FOR APPROVAL until it's approved (DRAFT before it's compiled). Approving checks that the books still give exactly those figures (if anything dated in
the year changed since, it's refused: reopen and send it again). Approving **agrees the year end**
at those figures (Accounts → Year end), **closes the year** (nothing more can be posted into it),
and keeps the signed PDF on file. Each step is in the audit log.

**Reopen** (the owner, with a reason) takes the statements back to a draft. An approved year stays
closed: its lock date can't be moved back while the statements stand approved, and after
reopening only by moving it (Accounts → Year end), which is in the audit log too.

## The public interest score

For a company, a non-profit company or a close corporation, Shap works out the public interest
score (Companies Regulations 26(2)) from the books: the average number of employees in the year
(the people paid on payroll and logged on days worked, month by month; changeable), a point for
every R1 million (or part) of liabilities at the year end and of turnover in the year, and a point
for each shareholder (a CC's members; blank, one per director). It says what the score points to:

- an **audit** at 350 or more, or at 100 or more when the statements are compiled internally
  (regulation 28), even when every shareholder is a director; an audited company names each
  director's remuneration (Companies Act s30(4));
- otherwise, when every shareholder is a director, **no audit or review** (s30(2A)): a compilation;
- otherwise an **independent review** (regulation 29): by a registered auditor (or a member of an
  accredited professional body) at 100 or more, or below 100 by someone qualified to be a CC's
  accounting officer;
- a close corporation without an audit: its accounting officer's report (s62).

It's an estimate, for the business and its accountant to check: who counts as an employee and
whether loans from the owners are third-party liabilities is the accountant's reading (Shap counts
every liability, and shows the owners' loans apart). Not for public companies, or a company holding
more than R5 million for others in a fiduciary capacity (always audited).
https://www.acts.co.za/companies_act_2008/r351_26__interpretation_of_regulations_affecting_transparency_and_accountability

## What to check by hand

- The cash flow statement leaves out assets bought without cash (7.18) but leaves their VAT in
  working capital.
- Leave balances, escalating leases, components of an asset, deferred tax: journals by the
  accountant where material (docs/IFRS.md lists them all).
