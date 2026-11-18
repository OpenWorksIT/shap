# Shap's CPD audit

Shap holds a business's books and its people's details, and an accountant signs what it draws
up. So, like the continuing professional development an accountant keeps up, every update is
checked the way the profession would check it, before any server or phone takes it: five
reviews, the tests and CI, each server checking itself, and the books checking themselves.
Shap Pocket (OpenWorksIT/shap-pocket) shares the accounting code and goes through the same.

## 1. Every update: the five reviews

Before the version goes up and the update is pushed, five reviews of everything since the last
release, each by someone (or a separate AI session) that didn't write it. Each finding is fixed
with a test that fails without the fix, in Shap and in Shap Pocket where the code is shared, and
each review's findings are written up in section 7.

1. **Security and privacy**, with the penetration test (`deploy/test/pentest.mjs` against a
   server with the demo company): who may reach what (every route, every role and task,
   `requireAccess`/`requireRole`), what each answer gives away, sessions and sign-in, files,
   nothing personal leaving without the owner's yes (`.github/hosts.json`, `privacy.test.ts`),
   the logs, and for Shap Pocket what runs in the app (no server-only code, the database worker,
   the store builds).
2. **IFRS for SMEs and company law** (docs/IFRS.md, docs/STATEMENTS.md): every decision the books
   and the statements make against the standard, section by section; the Companies Act and Close
   Corporations Act (the public interest score, the audit or review it points to, the accounting
   officer's report, the directors' report); what's left to the accountant, said so.
3. **SARS and tax** (docs/SARS.md): every rate, table, threshold, form and due date against
   SARS's current pages (with links), year by year; the estimates (income tax, provisional tax,
   turnover tax, the tax pack) worked through for each kind of business with made-up books; the
   other statutory bodies Shap touches (UIF for the Department of Employment and Labour, CIPC).
   Every figure Shap works out for tax or the law says it's an estimate: OpenWorks IT aren't
   accountants, and Shap isn't advice.
4. **Accounting and arithmetic**: double entry and the cent, and every figure the same wherever
   it goes: a document, the ledger, the reports, the VAT201, the payroll returns, the
   statements, the tax pack, the PDFs and the exports. A year of made-up trading through the API
   with its own books to compare. And data safety on upgrade: the same books give the same figures
   after the update (CI's upgrade job lists any balance that moved), and what was signed stays
   signed.
5. **Words on screen and liability** (from 1.26): everything Shap says to the people using it,
   on every screen, PDF, email, export, setup question and doc that changed, read as the owner
   would read it, and as someone holding OpenWorks IT to it would. Shap is free software from
   people who aren't accountants, tax practitioners, auditors or labour lawyers: nothing it says
   reads as advice, a promise, a decision about someone, or a figure to rely on. Tax figures and
   the public interest score, estimates and checks say they're estimates or aids (`ESTIMATE_NOTE`,
   `ESTIMATE_SHORT` in `packages/shared/src/terms.ts`); reminders and flags, however short, say
   they're worked out from what's captured and aren't advice, on screen or in the note beside them
   (`casualLabourNote`, `lawMonthsNote` for day labour). Where the law is the business's to follow
   (payroll, day labour, VAT, the Companies Act) the words say so and point to the accountant (a
   labour practitioner for labour law). The points and cautions said back before the terms are
   accepted (`termsPoints`, `setupCautions`) cover anything new the owner answers for. The
   website's disclaimer (openworks.co.za/shap/disclaimer) still covers what the update adds: it
   forms part of the terms (terms 8.3), so it's only clarified where the terms already cover it; a
   new duty on the owner or a further limit on OpenWorks' liability is a terms change
   (`TERMS_VERSION`, everyone accepts again). One that's only a practice's (Shap Accountant) goes
   in the Shap Accountant terms instead (`accountant-terms.md`, `ACCOUNTANT_TERMS_VERSION`: only
   practices accept again), whose Part A follows `terms.md`: when `terms.md` changes, Part A and
   `ACCOUNTANT_TERMS_VERSION` change with it. The terms aren't changed otherwise. The
   rest is plain South African English: clear, kind, no jargon without its meaning, the same word
   for the same thing, money as the app shows it (`formatZar`).

Then:

- CI is green on the commit, all its jobs, and `stable` moved to it (CI moves it; nobody moves it
  by hand: servers update from it).
- vps1 updates; `sudo /opt/shap/deploy/vps/audit-server.sh` shows nothing new; the books audit on
  its companies shows nothing new.
- The changelog says what changed, security fixes included once servers have had a chance to
  update (SECURITY.md).

## 2. When SARS changes something: the standard update

A Budget, a new table or rate, a new form or due date: anything in docs/SARS.md that changes.
And from 1 March, the tests fail until the new tax year's figures are checked (`SARS_CHECKED_TO`,
`packages/shared/src/tax.ts`), so a year can't start on last year's tables unnoticed: CI runs on
1 March and each Monday in March even with nothing pushed, and a server's home page tells the
owner its tables end before the tax year it's in. When a Budget's figures are still a bill, say
so in docs/SARS.md, and check them again once the Act is promulgated.

1. The SARS review (section 1) on what changed, from SARS's own pages: each figure, the years it
   applies to (a table applies to years of assessment ending on or after its `from`; a year
   SARS left unchanged needs no new row).
2. The tables changed where docs/SARS.md says they live, each with a test of a figure worked out
   by hand from SARS's table; `SARS_CHECKED_TO` moved to the last year checked; docs/SARS.md's
   checked date and sources brought up to date.
3. The same in Shap Pocket (the shared code is copied: `packages/shared/src`).
4. The version goes up, with the five reviews, as any update (section 1), and the changelog says
   which figures changed and from when.
5. From 1 March each year, the national minimum wage too (`NATIONAL_MINIMUM_WAGE`,
   `packages/shared/src/labour.ts`, docs/CASUAL_LABOUR.md): the tests fail until the tax year
   `SARS_CHECKED_TO` ends has its rate.

## 3. Every change (CI, `.github/workflows/ci.yml`)

Runs on every push and pull request. When **all** of it passes on `main`, CI moves the `stable`
branch to that commit. Servers update only from `stable` (`deploy/vps/ctl/shap-ctl.sh`), so a
change that fails anything never reaches a server.

| Job | What it checks |
|---|---|
| **test** | Type checks; every test, among them: |
| | **Accounting**: the VAT, payroll, tax, year-end, bank and bill rules (`year.test.ts`, `vat-lines.test.ts`, `payroll.test.ts`, …), each suite ending with the books audit finding nothing to fix (`expectCleanAudit`) |
| | **The books audit itself** (`books-audit.test.ts`): clean books pass; books broken on purpose are caught |
| | **Security** (`security.test.ts`, `hardening.test.ts`, `auth-races.test.ts`): password and code guessing, stolen sessions, cross-site requests, files that aren't what they say, spreadsheet formulas, what each role and each task may do on every route (`access.test.ts`) |
| | **Privacy** (`privacy.test.ts`): books full of made-up personal details; the usage note, market rates and feedback carry none of them; the server's log holds no names, addresses, searches, passwords or sessions |
| | the build |
| **audit** | The real server, from its Docker image, read-only, without extra powers, not as root, as production runs it, with the demo company (it can reach the internet: nothing in the test sends anything out). If it doesn't start, the job fails. The **penetration test** (`deploy/test/pentest.mjs`): every route as every role, refused with exactly 401 signed out and 403 for a role that may not; rubbish in every id and body, with a crash or no answer at all a failure; sessions, sign-in, headers, CORS, files outside the app, oversized requests. Then the books audit, and no errors or personal details in its log (values the database refused are listed in the summary) |
| **upgrade** | What servers run now (`stable`), its database brought up to this commit: migrations run, the books audit finds nothing to fix, and the account balances that changed are listed in the run's summary (the changelog should say why) |
| **dependencies** | Known vulnerabilities in what the server and web app run (`scripts/audit-deps.mjs`: high and critical fail unless accepted in `.github/accepted-advisories.json`, with a reason and a date to look again); every outside address in the code is on the privacy list (`scripts/privacy-hosts.mjs`, `.github/hosts.json`) |

Every step runs in bash with `pipefail`, so a check piped to `tee` fails when the check does. A
check that can't run (the registry unreachable, a route the scan can't read) fails rather than
passing. The penetration test reads the routes from the code (`deploy/test/routes.mjs`); the
security tests check it finds exactly the routes Fastify has.

Also on GitHub: Dependabot's weekly pull requests (`.github/dependabot.yml`), the weekly dependency
check (`dependency-check.yml`), CodeQL code scanning, and secret scanning with push protection
(the repository's Security tab). A ruleset on `stable` (Settings → Rules) blocks deleting it and
force-pushing it, so it can only move forward; nobody moves it by hand. Every action a
workflow uses is pinned to a commit (Dependabot moves the pins).

## 4. Every server, every 6 hours (`deploy/vps/audit-server.sh`)

The `shap-audit` timer runs it (installed by `ctl/install.sh`, or by the updater itself on its
next run) and after every update. It changes nothing. Its results show in **Settings → Updates &
backups → Checks**: SSH, the firewall and what listens (the database and the app never on the
internet), automatic security updates, disk space, who may change Shap's code (files and folders)
and read its secrets (`.env` and each company's) and backups, the containers, backups (recent,
sound, not readable by others, copied off the server), each site as Caddy serves it
(certificate, HTTPS, headers) and whether it's found by its public name, two-step sign-in, a
waiting update or a failed check for one. Anything it can't check is a WARN saying so, never an
OK. It holds nothing of any company's books. The main company's owner sees it (it names every
company's site on the server); extra companies' apps aren't given it.

The updater (`ctl/shap-ctl.sh`) takes only `stable`. If it can't fetch it (no network, GitHub
down, the branch gone), nothing is updated and Settings says why; it never falls back to `main`.

Run it by hand any time: `sudo /opt/shap/deploy/vps/audit-server.sh`.

## 5. The books, any time (`apps/server/src/audit/books.ts`)

**Settings → Updates & backups → Checks → Your books** (owner and accountant), or
`node apps/server/dist/audit/cli.js` in the app's container. It changes nothing in the books (it
brings the report totals up to date first, as any report does). It checks that:

- every posting balances, document by document, and the quick totals agree with the ledger, both
  ways (nothing missing from either);
- the trial balance and the balance sheet balance, today and at the last three year ends;
- debtors agree to the cent with the open invoices, creditors with the unpaid bills, PAYE/UIF/SDL
  with the final pay runs less the EMP201 payments. Journals typed by hand on those accounts (an
  opening balance, a correction) and the accountant's year-end adjustments are counted apart and
  shown, so the check stays exact and can fail;
- the VAT account moved, in each VAT period of the last year, by what Shap's VAT201 for it says.
  Both come from the same documents by different code, so this catches postings that went
  astray. It can't catch a return filed with other figures, or one not paid: Shap doesn't keep
  what was filed;
- agreed years still show what they were agreed at (the year as it was agreed, even if the year
  end in Settings changed since), and nothing dated in them was added or changed afterwards:
  what was posted to each account within the year is noted when the year is agreed and compared
  (worth a look while the year is open; wrong once it's closed). Agreeing or removing another
  year doesn't count, and nor does history brought in afterwards (a tracker import, moving in):
  that's where the books start. For years agreed before 1.21.1, from that update on. Old years
  not yet agreed are flagged;
- documents add up; while registered for VAT, tax invoices carry what SARS requires; credit notes
  say why; no invoice number went missing without a deletion in the audit log;
- VAT claimed has its slip; no cost claims more VAT than it can hold (the rule a cost is saved by:
  the VAT the amount includes at the rate on its date, and a cent for the supplier's rounding);
  everyone paid has an ID and tax number for their IRP5;
- sales and stock (docs/SALES_AND_STOCK.md): every sale has its payment and every refund its
  credit note, no more refunded than paid, sale numbers without gaps; the inventory account is
  the stock movements and the items' values, item by item; the stock purchases clearing account
  is empty and the supplier claims account is what's still owed back; every stocked line on an
  issued document moved stock; warnings for stock below nothing, valued above its selling price,
  not counted in a year, and claims older than 60 days;
- the database's own safeguards are there (the audit log can't be changed, journals must balance,
  sales, refunds and stock records can't be changed or deleted).

The annual financial statements (docs/STATEMENTS.md) can only be signed when they balance, the
cash flows tie, equity ties, nothing is in suspense and this audit finds nothing to fix; once
compiled they're frozen at their figures, and approving checks the books still give exactly
those.

## 6. Once a month

- [ ] Dependabot's pull requests and the latest dependency check: take what's worth taking (each
      goes through CI).
- [ ] `.github/accepted-advisories.json`: anything accepted that can now be fixed, or that's due.
- [ ] The repository's Security tab: code scanning, secret scanning, Dependabot alerts.
- [ ] Each server's Checks (Settings → Updates & backups): all clear, or each item explained.
- [ ] A backup restored to a scratch machine once a quarter, and opened (`docs/backups.md`).
- [ ] Who has access: GitHub collaborators, deploy keys, the servers' SSH keys.
- [ ] SARS news since the last check (a Budget, a new rate or table, a new form or due date):
      anything that changed is the standard update (section 2).

## 7. What each review found

### The first audit (November 2026, version 1.20)

- A date like `2026-99-99` in a list's filter crashed the request (a server error, not a refusal):
  any value the database can't take is now refused plainly (400).
- The server's log kept query strings (someone's search for a client's name) and, without email
  set up, the address an email was for: both gone.
- The feedback trail recorded a tapped button's label, which in a list row can be a client's or
  worker's name: now "in a list", with addresses and numbers blanked everywhere in the trail.
- Zod 3 (input checking) has a high advisory for huge lists; Shap already refuses those before
  Zod sees them: accepted until Zod 4 (planned).
- Shap Pocket has no Content Security Policy (a browser-enforced list of where the app may connect):
  to add, tested on a phone.

### The independent review of 1.21 (before release)

- CI's gates couldn't fail: a step like `pentest | tee` passed whenever `tee` did, and a server
  that never started passed its start step. Every workflow now runs with `pipefail`, and the
  start step fails if the server never answers.
- The books audit called correct books wrong: a year agreed at the accountant's figures (the
  quick totals and creditors checks didn't count the year-end adjustment), a cost's VAT the app
  had accepted (a different rounding rule), the year end changed in Settings after a year was
  agreed, and tax invoices from before deregistering for VAT. All fixed, each with a test.
- Some of its checks couldn't fail: debtors, creditors and PAYE only warned once any journal
  touched the account (pay runs always do); an agreed year always showed its agreed figures. Now
  exact (journals by hand counted apart), and an agreed year is compared with Shap's own figures
  as they were when it was agreed.
- The updater fell back to `main` on any network error (so a blip could bring untested commits),
  before taking its lock and with no time limit: now `stable` only, with time limits.
- The upgrade test started from the last version number, not from what servers run (`stable`).
- The dependency check passed when it couldn't reach the registry: now it fails.
- The penetration test took any refusal (a 400 for the made-up id) as the role check working, and
  didn't count no answer as a failure; both routes made by a helper were missed. Now exactly 401
  and 403, no answer fails, and the security tests check its route list against Fastify's.
- Values the database refuses (400) are now logged as a warning by code and route, so one the app
  should have caught still shows; division by zero is an error again.
- Still in the log: an email's subject when sending failed (it names the business), the recipient
  in the demo company, and a database error's detail (it can quote values). All gone; the
  mailer's own log lines are now tested. The feedback trail is blanked again on the server,
  whatever app sent it.
- The server check reported OK when it couldn't check (two-step sign-in with the database down,
  no update check yet), didn't look at folders or each company's `.env`, and checked sites by
  their public name only (a provider that doesn't loop back made a good site look broken).
- Shap Pocket's app and web workflows used actions by version tag: now pinned to commits.
- The reviewer then checked the fixes. Three more, all fixed with tests: agreeing an earlier year
  after a later one, or bringing history in after a year was agreed, made the later year look
  changed (each year is now compared by what was posted within it); and splitting a cost could
  give one part a cent more VAT than the app allows on a cost (each part is now kept within it).

### Sales, inventory and the financial statements (1.22, before release)

An accountant bot ran a year of made-up trading through the API (a VAT-registered shop and a
stall that isn't registered for VAT), with its own books to compare: 267 figures and 50 refusals checked. What it
found, all fixed with tests (`apps/server/test/sales-stock-review.test.ts`, `financial-statements.test.ts`):

- Voiding an invoice put its stock back dated the day of voiding, so its cost of sales stayed in
  the year its revenue left. Now on the invoice's date; a count since then points to a credit note.
- A walk-in's sale with a zero-rated item couldn't be refunded (its credit note asked for the
  customer). VAT that can't be claimed was left out of the stock's cost and what was owed. A
  business not registered for VAT could send a VAT amount that was silently dropped.
- Suppliers' credit notes on account couldn't be taken off a bill, so the bill still showed
  owing; goods back on an invoice still owed couldn't go back into stock.
- An approved year could be reopened from Settings, and a sale in it made an invoice. Stock could
  be dated before a count. Opening stock cleared by the opening balances always warned; an item
  stocked again after selling it unstocked failed the audit; a stall not registered for VAT had
  its stock judged against a price with VAT taken off.
- The statements: a bank overdraft added to cash in the cash note; a sole proprietor's words ("the
  owner are"), drawings reported as none, tax mentioned where there's none; the compiler's report
  named the IFRS for SMEs where note 1 describes a basis of its own. Loans from the owners with no
  fixed terms are now current (IFRS for SMEs 4.7(d)), and other invoice lines revenue.
- A report up to a past day refused when it was before this year's start.

Then the independent review (`apps/server/test/review-1.22/`), all fixed with tests:

- Stock takes, returns, claims and refunds didn't mark the books as changed, so the reports'
  quick totals went stale (and a set could be approved without a count in it). Every table the
  ledger reads now does, and the books audit checks it.
- Approving the statements deleted the tracker import's journal for the year, closing it at
  other figures than were signed. Kept now, and the signed figures are checked again as the year
  closes.
- A sale made an invoice could be edited (not registered for VAT) or paid again, even backwards.
- A stock purchase could be rounded by bank matching or a merge, or made without lines from the
  bank or a tracker import.
- A double tap could issue an invoice's stock twice or write a claim off twice.
- A return at an old purchase price could leave stock worth less than nothing (now at average
  cost); a discount could take a VAT class below nothing.
- `www.ifrs.org` was missing from the outside addresses, so CI's privacy check failed.

### People who sign in, the IFRS check and the tax pack (1.23, before release)

The independent review (`apps/server/test/review-1.23/`), all fixed with tests:

- People's pay: the tax pack printed each employee's certificate (name, pay, PAYE) for staff who
  read the reports but may not see payroll, and the books audit named them; logging days handed
  the worker's wage back. Both now leave people out without "See payroll", and logging days
  doesn't return wages. Reading the books comes with seeing workers' days and wages, since the
  ledger names them; bank statements come with capturing costs and payments, which they do.
- Time on jobs: staff tracking time saw everyone's, with the jobs' billing rates, and could
  change or delete anyone's. Each person now keeps to their own (the owner sees all).
- Saving an item returned its cost to someone who may change prices but not see what stock cost.
- The jobs (client, site address, notes) were open to anyone signed in: a job takes "See jobs",
  and the list to pick from is for those who log, capture or invoice against one.
- A write-down could be dated before later stock movements while worked out from what's on hand
  now: refused before the item last moved (a journal at the year end for the accountant).
- Upgrading: statements compiled or approved on 1.22 no longer matched their fingerprint (1.23
  draws the cash flows differently). From 1.23 the fingerprint is of the books themselves; a set
  signed before is compared by its four statements, and a close corporation's keeps no accounting
  officer's report it wasn't signed with.
- Tax estimates: the assessed loss brought forward was the net of every earlier year (there's no
  carry-back), and a company's set-off wasn't limited (the greater of R1 million and 80% of taxable
  income, s20(1)(a)(ii)); a trust's estimate in the statements ignored what it gave its
  beneficiaries. All three now worked out the same in the statements, the tax pack and the IRP6.
- An asset's bill settled by the owner personally or with a supplier's credit note showed as cash
  paid for it; subcontractors counted as employees in the public interest score; a reviewed close
  corporation's accounting officer's report said no review was done.
- Shap Pocket: the statements' fingerprint used node:crypto, an empty stand-in where the books run
  in the app, so uploading the signed compiler's report or approving failed there (from 1.6).
  SHA-256 in plain JavaScript now, in both, and Pocket's tests check the engine imports nothing
  of Node's.

The reviewer then checked the fixes (`review-1.23/second-*.test.ts`). All fixed with tests: an
asset's bill split between the bank, the owner and still owed rounded its parts one by one, so
the cash flows missed the cash by a cent and the statements couldn't be signed; a trust giving
out more than the year's income made an assessed loss of it (s25B: only the year's income is the
beneficiaries'); the non-cash note miscounted a supplier's credit note on another cost type; a set
signed on 1.22 was compared by its statements but not its notes; a later builder would have made
every set signed now look changed; and whoever makes the invoices could no longer put a
colleague's time on one.

### zod 4 (1.23.1, before release)

The independent review compared every schema under zod 3 and zod 4 (about 50 inputs a field):
the same output, nothing let through that zod 3 refused, saved statement details read back the
same, every id a valid uuid. Fixed with tests (`apps/server/test/review-1.23/zod-4.test.ts`):
a refused request said zod 4's own words where a schema has none ("Invalid input: expected
string, received undefined", a field's pattern): "Required" and "Invalid" again. Found on the way,
older: an unknown accountant export, and a feedback trail time no date can hold (on the open
collector too), were server errors, not refusals. The zod advisory accepted until Zod 4 is gone
from `.github/accepted-advisories.json`. Accepted: a whole-form check (a deposit as a percentage
or an amount, not both) is told only once the fields themselves are right; the request is
refused either way.

### The SARS review, and the four reviews on every update (1.23.2, before release)

The SARS review (an accountant bot through the tax and SARS rules, and a made-up small business
corporation through the API: `apps/server/test/review-1.23/sbc-and-sars.test.ts`), all fixed
with tests:

- A company that qualifies as a small business corporation was estimated at 27% (R108 000 on
  R400 000 of profit, against R26 198 on SARS's table) unless a provisional estimate for that
  very year said otherwise, and the statements and the tax pack could pick different estimates.
  The business now says whether it qualifies (s12E) on the statements or the IRP6 screen: every
  estimate goes by it, gross income over R20 million rules the table out, and not said, both
  figures are shown. The tax note shows the SBC rates' effect on its own line.
- Any tax in the books hid the estimate (a provisional payment journalled to the expense made it
  look booked): the tax booked is now compared with the estimate. Provisional tax paid has its
  own SARS payment (off what's owed to SARS).
- Booking the tax in a year agreed with the accountant changed nothing (the agreed figures hold),
  each tap booked it again, and closing the year then stopped the statements being compiled:
  the button is gone from agreed and closed years, which say why.
- The SBC tables before the year ending March 2022 used 2023's, and a year ending 31 March 2023
  had 28% at the top (27%); 2023's medical credits were 2024's; VAT categories D (six-monthly)
  and E (yearly) were missing; the dividends tax return was named without its DTR02.
- Each figure is now in docs/SARS.md with its source, and CI fails on 1 March until the new tax
  year's figures have been checked (`SARS_CHECKED_TO`).

Then the four reviews of the fixes (each by a separate agent), all fixed with tests
(`apps/server/test/review-1.23/sbc-and-sars.test.ts`, "the four reviews of 1.23.2"):

- Security and privacy: provisional tax paid (the year's income tax, so the profit) could be
  recorded, listed and deleted by staff given payroll: now the owner's, and listed only to those
  who see the books. Deleting a SARS payment wasn't logged. Saving a provisional estimate answered
  the SBC question for the business. A VAT201 for a date in the year 9999 was a server error. A
  sole proprietor could record provisional tax (theirs is the owner's own), and for any month.
- IFRS for SMEs and company law: the SBC answer was one for every year (SARS tests it each year
  of assessment): now per year, carried forward until changed, and the accountant may give it.
  The SBC line in the tax note went by the answer, not the tax booked (a wrong line when they
  differ): now by the tax booked. Nothing due on the SBC table showed "Book R0,00". A company on
  turnover tax was asked for income tax. A year was offered the tax booking when a later year was
  agreed. The rate line didn't name both years' rates when they differ (29.41(d)), and an assessed
  loss carried forward wasn't told. A set approved on 1.22 would have read as changed (the tax
  note's reconciliation is drawn differently): compared by its current tax only. The docs claimed
  a director's remuneration note Shap doesn't draw.
- SARS and tax: the SBC tests are SARS's for each year of assessment (above); nothing told a
  server's owner that its tables were behind the tax year (now the home page, and CI on 1 March and
  each Monday in March); docs/SARS.md now says the 2026/27 figures are still a bill (B34—2026), with
  SARS's own sources, the micro business dividend exemption and the trust's IT3(t), and what isn't
  modelled (gross income is taken as the income accounts).
- Accounting and arithmetic: the IRP6 screen ignored provisional tax already paid; the tax pack
  took a payment and the tax booked on the same day as one; the migration inferred the SBC answer
  from estimates saved with the box ticked by default (now nothing is inferred); the company file
  left the answers out. The same figures everywhere (statements, tax pack, IRP6), checked by the
  tests. Accepted: tax overpaid shows as a negative liability, not an asset; the accountant
  reclassifies it where it matters.

### The four reviews of 1.24 (before release)

Every sale an invoice in the invoice numbers, month end and the lock task. All fixed with tests
(`apps/server/test/review-1.24/four-reviews.test.ts`, `sales-invoices-locks.test.ts`; Pocket the
same):

- Security and privacy: putting time on an invoice changed issued tax invoices and paid sales,
  past the lock and with no audit entry (older than 1.24, newly reachable): time goes on quotes and
  draft invoices only, VAT by line, logged. A month due to lock itself wasn't locked for what reads
  the lock date directly (the database's job check, settings, the archive): every change locks it
  first, and a look no longer writes it. A teller's stock history showed other people's sales and
  the invoices with client names and amounts. Two locks at once could leave the earlier; the loser
  of a race on the lock day saw the old lock. Staff reading the reports saw who reopened the books
  and why. A sale could be paid again from a bank line, and changed (number, customer, job) through
  Quotes & invoices. Photo shrinking took slips from a closed month, not only a closed year. The
  penetration test's never-read lists now cover the locks.
- IFRS for SMEs and company law: the migration renamed a clashing old sale and dropped the number
  it was issued under (now: a draft gives way, an issued clash keeps both numbers, each renumbering
  logged); it added due dates to old sales (no longer). Reopened approved statements threw the
  signed set away (now kept, with its PDF and the reason). A company file, a move-in and a tracker
  import could change closed or signed years. The docs said a sale's invoice is never changed when
  it could be, and "the accountant's call" read as the owner's own accountant (now: on an
  accountant's advice to OpenWorks IT; not advice for your business).
- SARS and tax: a walk-in's sale with zero-rated goods took the abridged tax invoice; the proviso to
  VAT Act s20(5) rules that out for zero-rated supplies (up to R50, s20(6), none is needed): the till
  asks for the customer, and the books audit goes by the same rule. The full invoice made afterwards
  didn't say it replaces the abridged one, which couldn't be printed again. A reopen didn't say a
  filed VAT201 might be affected (and that late input tax is claimed in the current period). Adding
  a walk-in's details needed a reopen (it changes no figure). Old sales reprinted under new labels.
  docs/SARS.md now has the tax invoice and credit note rules with sources. Not changed, the owner's
  decision: a business that doesn't sell keeps the year's lock (a VAT vendor might want each VAT
  period locked; offered as a later option).
- Accounting and arithmetic: the upgrade gives the same figures (18 months of made-up books, every
  posting, report, VAT201 and the signed fingerprint identical). Undoing a bank match changed a
  closed month. An old sale number could be handed out again. The database let a sale's invoice
  become a draft or void (now refused). Month end's refunds counted refunds on other invoices.

### The four reviews of 1.25 (before release)

The test server: made-up books filled through Shap's own API for any setup, and wiped. Each
reviewer filled the books for many setups (about 60 fillings between them, every one passing the
books audit) and reconciled them. All fixed, with tests except where noted
(`apps/server/test/test-server.test.ts`, which now fills 14 setups and checks each against the
findings below, and `test/review-1.25/statements-checks.test.ts`, `fill-cleanup.test.ts`; Pocket
the statements' checks):

- Security and privacy: two fillings, or a filling and a wipe, could start at once (both got
  through before either was marked as running; the hold on other changes then lifted while one
  still wrote): one is claimed before anything is awaited. The filling's sign-in slid to 30 days
  like a person's (now keeps its 3 hours), and a restart part way left it behind with month end on
  "by hand" (both put right at start-up). The wipe took only the word WIPE (now your password too,
  as Settings → Wipe all data). Feedback still went to OpenWorks from a test server switched on
  with `TEST_SERVER=true` alone (now it stays on the server). The log had the API's own error text
  (now where it stopped only). "New books only" missed time, bank statements, year ends and tax
  estimates. The streets were real ones (now "Test Street" in "Fictional Town"), and the suppliers
  and businesses are marked "(made up)". `add-company.sh` could put `:companies.yml` inside a
  comment or a quoted `COMPOSE_FILE`; a test server now has one CPU and 1 GB. Not tested: the log's
  text, the refresh sent when the filling ends, leaving the demo while it fills. The penetration
  test against a production-mode test server: 286 routes, nothing to fix.
- IFRS for SMEs and company law: labour went on jobs paid up front after their tax invoice, so it
  sat in work in progress until the day the books were filled (13.14, 23.14). A business not
  registered for VAT had its stock booked without the VAT it paid (13.6). A trust got a second
  distribution, three months after the year end, flagged as passing straight to the beneficiary
  (s25B). Companies with payroll traded on an overdraft nobody arranged (the owners now lend what
  it needs); and the statements had no going-concern check except a CC's deficit: now every kind of
  business (3.8; business rescue for a company or CC, Companies Act s128(1)(f), s129(7), CC Act
  s66(1A)), with checks for distributions declared after the year end (32.8, 32.10) and for stock
  on hand when Shap doesn't keep it (13.4). The statement of
  changes in equity called a CC's, trust's and co-op's capital "Issue of shares" (CC Act s24). The
  co-op had one member (Co-operatives Act s6(1)(a): now five, sharing the distribution). The
  statements named the person signed in as director (now the made-up owners). Left to the
  accountant and said so in docs/TEST_SERVER.md: a co-op's indivisible reserve (s46), leave pay,
  the solvency and liquidity test, revenue on a pro-forma job before the work.
- SARS and tax: non-VAT and turnover-tax setups traded far over the compulsory VAT registration
  line and the turnover tax limit (now about 70% of each). The logbook logged one way and moved the
  odometer both ways (halving the business share), and kept its readings by the business's year,
  not SARS's tax year. Provisional tax followed neither SARS's method nor Shap's own estimate (the
  second payment ignored the first; partners taxed on one table; a trust on what it distributed):
  now Shap's own estimate. The first VAT period, when it started before the books, was never paid
  or refunded. Costs planned for a day before their month were dropped (rent in about half the
  months). SDL stayed off on payrolls over R500 000 (now kept under it without SDL). The director
  got medical tax credits with no medical aid. Private kilometres with full input VAT (s17(1):
  now under 5%, and none for companies). A new hire started the day the leaver ended. The VAT rate
  and the R50 limit were written in (now `vatRateOn`, `NO_TAX_INVOICE_CENTS`; docs/SARS.md says
  the generator takes its rates from the shared code). Turnover tax's interim payments (TT02) now
  made for a sole proprietor or partners. Said in docs/TEST_SERVER.md, not changed: Shap's casual
  labour has no UIF or PAYE; a company's TT02 payments have no payment kind in Shap.
- Accounting and arithmetic: every figure reconciled to the cent (bank, till, debtors, creditors,
  wages, VAT, stock, dividends tax, the EMP501, the exports). Month end that locks by itself made
  the filling fail on its first write (the lock came before the route set it aside; now the
  route's own lock check skips it, and the lock is cleared while the books are new). Two fillings
  doubled the capital. The till could go below nothing on a cash refund. Most made-up businesses
  ran an unfunded overdraft at the test scale (fixed costs now scale too). Time entries all started
  at 08:00 (not tested). Other open screens weren't told when the filling ended. "The same books
  whichever day you fill" holds within a financial year (now said). Not changed, older code: the
  balance sheet report and the statements show provisional tax paid differently, both balanced;
  computers go to "Tools & equipment at cost"; a non-vendor's stock is coded "supplier not
  registered for VAT" whatever the supplier (`stock.ts`; no figure changes).
- The fixes, checked by a separate agent: capped trade stopped part-way through each month (now
  spread over it; tested at full size); a distribution counted as after the year end however many
  years later (now up to the next year end); "The owner assess", and a CC left out of business
  rescue and of the going-concern check unless overdrawn; `add-company.sh`'s hand-fix path left a
  company half made (the line is checked before anything is made); the filling said it was done
  before putting month end back, and failing before it began left its sign-in, month end aside and
  the books "busy"; a browser could sign in as the filling's sign-in. Tests that couldn't fail now
  can: the limits (at a fifth of the size nothing reached them), the logbook (an empty year was
  skipped), each VAT201 against field 20 and its due date, each provisional payment against Shap's
  own screen on its day and TT02 against the year's turnover tax, the new hire's start. That last
  check found the year-end payment worked from the year to the month before (a trust's, after its
  distribution, came out well short): now the year as it stands that day. Also: the slip's VAT rate written in, trips before the vehicle
  was bought, the new hire's job, the wording on liability in the docs and changelog.

### The five reviews of 1.26 (before release)

VAT period locks for a VAT vendor that doesn't sell, day labour and the law, and the first words on
screen and liability review. All fixed with tests (`apps/server/test/review-1.26/`; Pocket the
same, `packages/engine/test/review-1.10-*`):

- Security and privacy: nothing exploitable; the penetration test, 286 routes, nothing to fix. The
  minimum wage's cited source wasn't on the privacy list (CI would have failed): now the Gazette
  and the Minister's statement, `www.gov.za` listed, and a test that every cited source is. Books
  from 1.25 that kept month end "by itself" after switching Sales off would have started locking
  their VAT periods by themselves on the update (a migration puts them on "by hand"). A settings
  change (Sales, VAT registration, the VAT category, the year end) could lock the books at once,
  over a reopen: now a new way of closing starts by hand, a recut one carries on from its next
  day, and the settings log says what changed.
- IFRS for SMEs and company law: day labour, usually employment in the law whatever the hours,
  didn't bring the employee benefits policy, and nothing told the accountant PAYE and the
  Compensation Fund (and, from about 24 hours a month, UIF) on day wages aren't in the books (28.4),
  or, from about 24 hours a month, the leave pay item (28.6, BCEA s19(1)): all now.
  Employee costs included subcontractors (28.1): on their own line. Closing by VAT period closes
  the year with its last period, before the accountant's year-end journals: said in setup, Locks
  and docs/LOCKS.md, and switching to "by itself" asks first when it would close a year not agreed
  or approved. The statements' page (and the partners' profit share, the archive, the books audit)
  read the stored lock, not one due: now the lock as it stands.
- SARS and tax: the VAT periods, every category, year end and lock day, are right. The day labour
  note said 24 hours a month is where someone becomes an employee: that's only UIF's line and the
  BCEA's hours and leave; the minimum wage, PAYE and the Compensation Fund have none. "Often a flat
  25%" for PAYE: SARS's tables apply to most day labour (standard employment, or deemed: at least 5
  hours a day for under R394 a day, 2026/27), now in the shared code and tied to `SARS_CHECKED_TO`.
  The EMP201 and the SDL hints left out day wages: the EMP201 says so, the hints count them, and
  Home warns when salaries and day wages pass R500 000 with SDL off. A lock day after the 25th can
  come after the VAT201: Locks warns. Late supplier invoices once a period is closed: not filed,
  reopen; filed, a later return within five years (s16(3)). docs/CASUAL_LABOUR.md's leave, records,
  minimum wage and LRA rows corrected, with primary sources; category F and fixed-day period ends
  under "Not modelled".
- Accounting and arithmetic: `periodLockDue` and `nextPeriodLock` matched an independent version in
  1.39 million cases. The workers' months came from the database's clock (and counted days logged
  ahead as this month's): now Shap's own day, bounded. Home's month end now also names an older
  month still open (pinned by a test). Locks shows each period's credit notes.
- Words on screen and liability (the first): the day labour wording decided who's an employee
  (on a named person, in bold), stated the law as a flag, and gave 24 hours as the line for all of
  it; the reminders didn't say they're reminders, not advice. Now: "usually your employee in the
  law", "may apply", "from the days logged", "a reminder, not advice", everywhere they show, and
  among the cautions before the terms. The website's disclaimer said Payroll pays and files (it
  doesn't), and didn't cover periods that lock by themselves: both clarified, within terms 2.2 and
  3.2 (no re-acceptance). Its own brief tightened (section 1, item 5).
- The fixes, checked by a separate agent: the statements' PAYE and Compensation Fund item still
  started at 24 hours a month (now any day labour; UIF and leave from 24 hours). The ask before
  locking by itself closes a year missed the year the next lock closes, and skipped it while the
  books were reopened (now up to the next lock, reopened or not; Locks and Home say which year the
  next lock closes). The test of a settings change over a reopen passed without the fix (now one
  that fails without it). CASUAL_LABOUR.md's BCEA row (Chapter Four from 24 hours a month, s28(1);
  five employees, s28(2)(a); s9A below the threshold) and s198C's exemptions. The casual caution
  before the terms left out PAYE and the Compensation Fund, and SDL for a business without
  Payroll. Home's SDL warning sent a business without Payroll to a switch it doesn't have. Day
  wages with the EMP201 and SDL showed to staff who see payroll but not wages (now labour.view too).
  "SARS's tables usually apply" too sure; the minimum wage "now" goes stale (now with its date).
  The test server's salaries without SDL left day wages out of the R500 000.
- And checked again: the company file's and the test server's fixes had tests that passed without
  them (now ones that fail: a company file with a new VAT category from "by itself" locked to
  August; a builder company filled at full size); setup's hint promised Locks would ask (it asks
  when "by itself" is chosen again: said so); with SDL on, nothing said Payroll's SDL leaves day
  wages out (Home says so now, and the EMP201's day wages line names SDL); SDL stated as due
  without its exemptions or the accountant; the statements' item named UIF with no month at 24
  hours.

### The reviews of Shap Pocket 1.10.1 (Shap 1.26.1)

Pocket 1.10.1 fixed Send (a stray hook call in Pocket's screen only) and went out before its
reviews, at OpenWorks' call; Shap got the same check of its screens (`web-hooks.test.ts`), a test
only. The five reviews of it found these in the code the two share, fixed in both with tests
(`apps/server/test/review-1.26.1/send-drafts.test.ts`, `web-actions.test.ts`; Pocket's section 3,
1.10.2):

- IFRS and SARS: Share PDF and Email on a draft invoice or credit note sent a PDF headed "Tax
  invoice" (or "Credit note") asking to be paid, for a supply not in the books or the VAT201, and
  issuing's checks (s20(4), s21(3)) never ran. They ask to issue it first, and a draft's PDF and
  email say "Draft invoice" or "Draft credit note", without the payment details.
- Accounting: Share PDF and Preview carried on when the save before them was refused, with the PDF
  as last saved; Email didn't save at all. They save first and stop when it's refused;
  `web-actions.test.ts` finds an action that swallows its own errors awaited inside another.
- SARS: what a document is called comes from its own VAT rate, in one place
  (`documentHeading`/`documentName` in `@shap/shared`) for the PDF, its file and its email.
- IFRS and SARS: the delete warning read `sharedAt`, which the API doesn't have; Share PDF didn't
  record that it went out (and counted a cancelled share sheet as sent). Now `/shared` after a
  share that wasn't cancelled, and `sentAt`, typed, through `hasGoneOut`.
- Words: "Something went wrong" told the owner nothing and lost the cause: one wording
  (`UNEXPECTED`), the error into Feedback's trail, checked in every screen.
- Security and privacy: nothing to fix. The hooks check now also finds a hook imported under
  another name, called on any namespace, or in a handler named like a component.
- The fixes, checked by a separate agent: the server's own unexpected error (and the monthly
  invoices' fallback) still said "Something went wrong": now `UNEXPECTED` from `@shap/shared`, the
  screen logs the failing route to the trail, and the wording check reads the server too. A
  voided invoice still asked to be paid on its PDF and in its email: only an issued invoice (and a
  pro-forma) asks now (`asksForPayment`). The screen fixes had no test that failed without them:
  `web-actions.test.ts` reads the wiring (Email only through the question, a share recorded and a
  cancelled one not, `hasGoneOut`), each failing on 1.26.0. The email drawer said "Invoice" for a
  draft and showed "Couldn’t send" without logging: fixed. "Asks for no payment" overstated it (a
  draft still shows its due date and terms): "without your payment details" now.

### The five reviews of 1.27 (Shap Accountant, phase 1; before release)

A practice's clients' books, each in a database of its own on the practice's server. All fixed with
tests (`apps/server/test/review-1.27/`, and `test/accountant/practice.test.ts`):

- Security and privacy: signing out in a client's books left the practice signed in behind it (on
  a shared computer, a reload signed the last person back in): it signs out of both now. The demo
  company reached the real practice's list, its staff and its clients, and could change who opens
  which: the practice is behind the demo's wall, with the server's own routes in one shared list
  (`lib/server-only.ts`), its security audit (`/api/audit/server`) now among them, for clients
  too. Lowering someone from writing up to compiling left them the client's owner until they
  reopened it: a change of level takes them out at once, and every request checks they're in as
  they were let in. A client's Welcome sent its usage note to OpenWorks: nothing about a client's
  books is sent (no usage note, no prices, both questions not asked there, both off in a new
  client's books). Client databases let every other database login connect: `revoke all on
  database … from public`, at creation and every start. Start-up held a connection per client:
  one at a time, each pool closed, at most 12 client pools open at once, and adding, opening and
  the checks rate-limited. The checks kept employees' names in the practice's database: counted,
  not named. The penetration test's section 6 now tries someone given one client reaching
  another, a level lowered or taken away, an archived client, the demo, reads through a forged
  cookie, and signing out, and uses its two clients again rather than adding two each run.
- IFRS for SMEs and company law: the practice approved and signed a client's statements as its
  board, and the signed set named the practice's people as its directors (and took it as
  owner-managed). In a client's books the practice compiles in Shap and records the directors'
  approval, with the page one of those named signed (Companies Act s30(3)(c)); the practice's
  people are never taken for directors; nothing is owner-managed until said; and nothing is
  compiled until those who approve are named (a check that stops compiling, everywhere). The list
  checked a year before the books began, and hid real errors: the newest year the books reach, or
  "couldn't run". It said "every check passes" where compiling would refuse: the books audit at the
  year end too. It now says where the statements stand (draft to approved), when a signed set no
  longer matches the books, the assurance the score calls for (with Regulation 29(5)), and an
  earlier year not approved. Wiping the practice's own books lost its clients: the list and who
  opens each are kept. The practice's owner can download each client's backups (s24), and
  docs/ACCOUNTANT.md says what the client's records duties are (s24, s25, s28). The level is
  "compile", not "review", which read as an independent review.
- SARS and tax: an NPC had no returns (now a company's, or an approved PBO's IT12EI), a company on
  turnover tax was shown an ITR14 (its TT03), the window behind missed an ITR14 a year back, monthly
  VAT and the EMP201 after next, there was no third (top-up) IRP6, an employer registered for PAYE
  with nobody on payroll had no EMP201, a partnership's labels said the partnership pays, the
  VAT201 date didn't say it's eFiling's, and a trust's Category E period used the books' year end.
  All fixed; the filing season's dates (ITR12, ITR12T, IT3(t), the EMP501 interim) in a table
  (`FILING_SEASON_DATES`), dividends tax, and the declared 4 November 2026 holiday
  (`DECLARED_HOLIDAYS`); all in docs/SARS.md. The list went stale: the returns are worked out again
  for the day they're shown.
- Accounting and arithmetic: a client whose migrations failed at start opened on the newer code
  (marked, and not opened until they run). A client's monthly invoices were never made (now on
  their day, never emailed). Coming back from a client showed the checks from before (now waited
  for), an earlier run could overwrite a later one (never now), and leaving closed a month in the
  client's books (it changes nothing now). The findings could leave a fail off the list (fails
  first). A half-made client database was left behind (dropped), and a database already there is
  never taken over. The test drops the client databases of whatever test database it runs on, and
  a test writes real books in a client and counts the checks exactly.
- Words on screen and liability: "every check", "kept apart by Postgres itself", "all of Shap's
  screens", "Returns:", "Books audit:", "was due" alone, "Writes up the books" (it makes them the
  client's owner) and the note at the foot of the list. Now: three of Shap's checks, a database of
  its own with Shap checking who opens which, Shap's screens, "Some returns coming up", "Books
  check", "was due (Shap can't tell whether it was filed)", the levels' own words (shared:
  `LEVEL_WORDS`), and `PRACTICE_NOTE` under the heading naming accountants, tax practitioners and
  auditors and saying it's not every check or return. Names on the page are marked private for the
  feedback screenshot. The bar could show the practice's own books under a client's name when the
  client closed: refused, and back to the list. The terms are accepted "for my practice's use of
  Shap on these books"; switching the feature on says back what the practice answers for; the
  website's disclaimer has a section on practices (within terms 2 and 3: no re-acceptance). The
  errors, the drawer (staff only, every client for whoever manages), the archive question, the
  deadline labels, the feature's hint (hidden in a client), the changelog and the docs. For
  OpenWorks to decide: an indemnity from a practice against its clients' claims would be a terms
  change (everyone accepts again).

- The fixes, checked by a separate agent: a page still in a client's books after it closed could,
  once a refusal had cleared its cookies (the live stream reconnecting, a PDF link), read and write
  the practice's own books under the client's name; the page now says which client's books it's
  in on every request (and the live stream), and a request not routed there is refused. A
  recorded approval's PDF said the director "approved in Shap": it says signed on the day and
  recorded in Shap by the practice person, from the signed page, which now opens from the screen
  (and a reopen clears it); reopening a client's approved statements is the practice's owner's.
  Pools let go when twelve are open are no longer ended under a request still using them, and the
  background jobs (the checks after an update, the clients' monthly invoices) use pools of their
  own. A client the server stopped making has its database dropped too. The penetration test's
  walls section gives site staff the task it needs (and takes it away after), adds from an address
  of its own, and fails rather than skips the demo where the server has one (CI runs with the
  demo off: there the in-process tests try its wall). The wipe screen says the clients' books stay; a
  client's statements screen says the practice compiles and records; "The owner who approves"; the
  Regulation 29(5) sentence beside a review only; an unexpected error on any screen in a client's
  books sends people to the practice's Feedback; a trust brought in from a company file keeps a
  February year end (existing books are left as they are); the misplaced comments and the EMP501
  interim season's source; the filing season tied to `SARS_CHECKED_TO` by a test; the disclaimer's
  section says a practice uses Shap on its clients' behalf, without narrowing the terms' "you".
  Tests that didn't prove their fix now do (`test/review-1.27/fix-check.test.ts`: the returns for
  the day shown, an earlier year not approved, the role checked, a half-made database dropped, the
  rate limit, the pool cap), and the backups test names its dumps after its own database.

### The five reviews of 1.28 (Shap Accountant, phase 2: books from another package; before release)

A trial balance and a general ledger from Xero, QuickBooks or Sage, read from the package's own
exports and brought into a client's books. Every finding fixed, each with a test that fails on the
code reviewed (fdd10b3): `apps/server/test/review-1.28/` (security, IFRS, accounting and SARS
files, the reviewers' own scenarios; run against fdd10b3, 50 of 54 fail, the other four checking
what was already right: the column cap, a day's lines together, three applies at once, the totals
after a take-out), and `test/accountant/books-import.test.ts`.

- Security and privacy: reading an .xlsx took time with the square of its size and blocked every
  request on the server meanwhile (10,000 rows: 33 s; a 6 KB file with one cell far off: minutes);
  only the cells the sheet holds are read now, counted (2 million a file, 4 million a request), and
  a cell past the 200th column is refused. The zip guard believed the file's own directory: each
  entry is unpacked and counted as it comes (64 MB at most), one spreadsheet at a time. A CSV
  millions of columns wide took 7 s and 684 MB: 500 columns and 5 million cells at most, refused
  as it's read (every CSV Shap reads). Staff given books.adjust could add accounts to the chart
  through an import, and one file could add 200,000: only the owner adds them, 500 at most an
  import. A long account name was a server error, and an account brought in without a code got
  one from its name that broke its ledger's download and was longer than the chart allows: names
  cut to fit, codes that fit the chart (IMP-1, …), and download names cleaned. A journal brought
  in could be changed or deleted on its own: refused (bring the period in again). The feedback
  trail named a changed field by its label, which can carry an account's or a person's name: a
  field or button in a list or among private details is named only by where it was (shared:
  `trailFieldName`, `trailButtonName`). The penetration test's never-reads lists have the import,
  and section 5 sends a spreadsheet with a far-off cell, one whose directory lies and a CSV
  millions of columns wide, each to be answered within 3 s with the server answering everyone
  else meanwhile. Agreeing a year deleted what was brought in, and taking out an import could leave
  a later trial balance wrong: below. Two cited addresses added to `.github/hosts.json`.
- IFRS for SMEs and company law: agreeing a year end (and replacing a company file, and the old
  tracker's replace) deleted every journal brought in up to it: only the tracker's own journal is
  replaced now, and an agreed year takes nothing more. New accounts went on the wrong statement
  lines (a fixed asset and its depreciation as other current assets, a long-term loan as a trade
  payable, the bank not as cash): the line comes from the package's type and the account's name,
  and Shap's own accounts (VAT, PAYE, income tax, dividends, retained earnings, debtors and
  creditors and others) are suggested for theirs. An expense could be mapped to an asset, and a
  code alone suggested an account across kinds: refused, and a code only with the same name. A
  trial balance brought in again undid the practice's own entries: they stay on top (what was
  brought in is measured against the imports only), and the check says how many. Depreciation in
  a journal (by hand, or within a trial balance's) wasn't added back in the cash flows (7.8): it
  is. A difference in an earlier, closed year landed in this year as an equity movement: refused
  as a prior-period matter (10.21), and shown when the years are open. A package year other than
  these books' double-counted silently: the preview shows the year a trial balance is taken for,
  the check shows what it would move account by account, and a title's other start is refused.
  Taking out a ledger under a trial balance left it wrong: refused. Each file's SHA-256 is kept,
  and the log has each import, each replaced and each taken out (ISRS 4410 (Revised) 38(b)). An
  account's kind is taken from whichever file gives it. Brought in alone, a trial balance's
  statements start from nil before it: the statements' checks say so, and docs/ACCOUNTANT.md says
  which trial balances to bring in. Not confirmed: Xero's YTD columns against a real export.
- SARS and tax: the VAT201 screen and the tax pack showed nil returns for VAT brought in, and the
  books audit said the VAT agreed: those periods say "From another package" (Shap doesn't work
  them out or check them) and the audit leaves them out and says why; PAYE journals brought in are
  counted apart from those by hand. The provisional and turnover tax estimates counted the months
  after the last import as nil: they project from the last day brought in, and say so (the VAT
  registration watch too). The package's tax accounts became ordinary new ones (income tax
  deducted, a sole proprietor's interest counted as turnover): Shap's own are suggested. A trust's
  package year landed in the wrong year of assessment: the preview shows the year, and a title
  with another start is refused. A trust's distributions brought in were taken as nil: shown, not
  taken off (s25B is the accountant's). A dividend in a ledger brought in now lists its DTR01.
- Accounting and arithmetic: lines outside the title's period were posted (past the lock): the day
  order is the one that fits the title, a line outside it is refused, and the lock and approvals
  are checked on every line's date. Real accounts and transactions were dropped as totals or
  opening rows (QuickBooks' "Opening Balance Equity", a memo "Opening Balance", a garage called
  "Total"): only rows wholly a total or such a phrase are skipped. A trial balance with opening and
  closing columns was read from the month's movements: the closing or YTD columns, with opening +
  debit − credit = closing checked, and movements beside an opening column refused; Sage's export
  steps say to summarise profit and loss. Dividends ran to date where Shap closes them each year:
  closed, as Shap's own trial balance does. A bare Type column in a ledger is the transaction's, not
  the account's; an inactive remembered account isn't used; the "already" count is of entries; an
  Excel number with three decimals, "R (1 234.56)" and "1 234.56 Cr" are read right (`parseMoney`,
  also Shap Pocket's); the count of journals is of those made.
- Words on screen and liability (a second reviewer: the first stalled trying to open a browser,
  and was stopped): nothing on the page said what was brought in isn't checked, and the docs said
  Shap checked it. `IMPORT_NOTE` (shared) now says Shap reads the files as it finds them, doesn't
  check them against the package or the client's records, and to compare the trial balance before
  relying on them, with who OpenWorks are; `PRACTICE_CAUTION` and the docs say the same, and the
  website's disclaimer has a section on books from another package (within terms 2.2 and 3.1: no
  re-acceptance). The books audit said it checked every VAT period when the VAT of all of them came
  in from the package: it says there's no VAT201 of Shap's to check. VAT charged and paid in one
  period netted to nil and showed Shap's own nil return: any VAT line brought in marks the period
  (`importedVat`, one helper for the screen, the tax pack and the audit), and the words say the
  return is the business's, not "the one worked out in that package". The tax pack says the
  year's figures came from another package, to the last day brought in, and a trust's
  distributions brought in aren't taken off. The check step's "as their package has them", "stay
  on top of it" and a cause stated as fact; "counted twice" without "if the package has them
  too"; "only right once"; the mapping hint (a code only with a name like it); Sage's export steps
  (the box's name, CSV) and a line that menus differ; "never left wrong", "is all there"; the
  reader's dates, money and "may be missing"; the audit's fail lines naming what they leave out;
  the year-end advice; the intro for any business; the Practice field; the journal refusal (that
  file, not that period); the VAT watch's 12 months to the last day brought in. Tests:
  `test/review-1.28/words.test.ts` (6, each failing on 984460a). The take-out error now goes to
  the console too (the unexpected-error test).

### The five reviews of 1.29 and Shap Pocket 1.11 (Shap Accountant, phase 3: the Pocket share; before release)

Each reviewer read both apps (Pocket makes the share, Shap brings it in). Between them they found
one cause behind most of their findings: the share carried only postings, so the copy's VAT201s
(the VAT came in as journals, boxes empty), PAYE and EMP201s, a partnership's turnover tax,
provisional tax paid, half of an asset's proceeds as turnover, the dividends tax return's day,
the statements' lines, cash flows, notes and checks, all came out other than Pocket's own from the
same books. Pocket's tables are Shap's (62 identical, the rest Shap's with a few columns more), so
the share now carries Pocket's records themselves (`SHARE_TABLES`, packages/shared
pocket-share.ts, the same file in both apps), and Shap puts them into the copy: its screens then
work from what Pocket's do. Tests: `test/accountant/pocket-share.test.ts` (a second database plays
the phone; two shares made by Pocket's own engine, `test/fixtures/pocket-share-1.11*.json`, come in
entry for entry) and `test/review-1.29/statements.test.ts`; Pocket's `share.test.ts` and
`shared-statements-1.28.test.ts`.

- Security and privacy: a compiled year could change under the practice (nobody can close or
  approve in a copy): the practice's compiled or approved statements now hold their year's
  figures, and the business details they were drawn on, refused and listed. Nothing tied a share to
  its books: each carries the books' own id (Pocket makes it once), pinned by the first share.
  Two at once both applied: one at a time (an advisory lock). Doctored numbers, amounts, dates and
  columns, and duplicate entries, are refused when read; the share number is capped; the body
  limit is the server's upload size; who may bring one in is asked first; the record keeps counts
  and the file's SHA-256, not descriptions. What leaves the phone is said in full (workers,
  employees and shareholders by name, with what they were paid), and people's ID, tax and bank
  numbers, contact details, photos and who signs in never do. Pocket's hosts list has the cited
  holiday notice.
- IFRS for SMEs and company law: the statements from a share differed from Pocket's (statement
  lines, depreciation, disposals as negative purchases, non-cash purchases, notes, the public
  interest score's employees, Pocket's checks): from the same records now, figure for figure (the
  test compares both years' statements). A share changed the business's details under an approved
  year: refused while a year is compiled or approved here. A cost put right as an asset by journal
  was negative depreciation (both apps): an asset bought. Pocket's placeholder "Owner" passed the
  approvers check: never named. Books beginning with a move-in's opening balances weren't flagged
  (both apps): "The opening position is in the books". The record: the file's hash, the audit log
  of each share and who brought it in.
- SARS and tax: the VAT201 (its boxes from the documents' own VAT codes), the EMP201s and EMP501
  (PAYE registration in the settings), turnover tax (the partners, asset disposals), provisional
  tax paid (SARS payments), the DTR01 by the day paid, the day-labour reminders: all from Pocket's
  records now, so nothing says "from another package" in a copy. Pocket's holiday comment put
  back in order.
- Accounting and arithmetic: account kinds and lines changed in Pocket now follow (the accounts
  come with each share, keeping the copy's ids: `sys_account()` is fixed in the database's plans,
  so a system account never changes id); Pocket's "what changed" read its marks through a layer
  that renamed their keys (credit notes and the like counted as changed every time): kept as
  text; a renamed worker or a line order refused a whole share in a closed year: figures only
  (`figuresHash`), lines sorted; an entry moved to another day counted twice: once (`shareDiff`);
  a share Shap couldn't read: Pocket checks its file against the schema before offering it, and
  cuts descriptions to fit; the first share no longer lists everything as new; the same share
  again says it's already here.
- Words on screen and liability: the panel's `SHARE_WHAT_GOES` says everything that goes and what
  doesn't, and that nothing goes until the owner chooses; "Last shared", dated in South Africa
  (`dayOf`); the share sheet's message says each share is the whole of the books
  (`pocketShareMessage`); the balance refusal says where to look and that it's a fault; Shap's
  drawer says the books are "as the share has them" with `POCKET_SHARE_NOTE` (Shap doesn't check
  them against the client's records); the first share records the practice's acceptance of the
  terms; the refusals say what's true (already here; another books'; this Shap may need updating;
  for the owner or whoever writes them up); a new Pocket client's card says to bring in its first
  share; the docs. The website's privacy page and disclaimer say what a share carries (within terms
  3.1, 3.8 and 4.1: no re-acceptance).
- The fixes, checked by a separate agent: a second share failed for any client who had sold over
  the counter (the copy's counter sale pointed at its receipt, and refunds and stock records,
  never changed or deleted in Shap, were replaced with each share): what points forward is let
  go first, and the share's own transaction may replace those records (migration 049, a setting
  that ends with it). A compiled or approved year's statements could still move when an account's
  kind or statement line changed on the phone, its entries the same: each such year must still give
  its signed figures (`stillSigned`) or the share is refused, saying which. A share without one of
  Shap's own accounts deleted it, and the next gave it another id, which the database's plans
  don't see: Shap's own accounts are never taken out (one left out stays as it is), and a share with
  one this Shap doesn't know is refused. The entries were checked against each other in a way that
  took seconds at 40 000 (one pass now, shared: `entriesOff`). The panel said less went than does:
  each share is now the whole of the books whatever their dates (every entry checked, not only to
  the day it was made), the words name the business's tax numbers and its statements' details, and
  the brand's address and the trips' places stay on the phone (`SHARE_WHAT_GOES`, the docs, the
  changelogs and the website's privacy page; Pocket's `share-file.test.ts` holds the words to a file,
  and makes Shap's fixtures). Pocket checks the read limits Shap holds a file to before it offers
  one (`shareProblem`, shared). The copy says the practice compiles and records the approval; Who opens it says what writing up a Pocket client's copy is; a restored phone is said as
  what the stamp suggests. Who may bring a share in is asked before its file is read, not after.
  Tests: the two-at-once test with shares that differ (it fails without
  the lock), recording an approval in a copy (no year end, no lock), the partners and an asset's
  proceeds on turnover tax, provisional tax paid and day wages in a copy, every record across,
  an account's kind following the phone in an open year, the share route for a client kept here,
  and the words (`test/review-1.29/share-check.test.ts`, `words.test.ts`, and
  `test/accountant/pocket-share.test.ts` with both of Pocket's own share files).
- Those fixes, checked again by another agent: a sole proprietor's saved tax estimates (their
  income from elsewhere, retirement contributions, age) and the logbook's vehicle went in a share,
  and nothing said so: they stay on the phone now, and the share-file test makes both and finds
  neither. Renaming an account on the phone could still move a compiled year's cash flow (the
  statements add depreciation back partly by an account's name, which the signed fingerprint
  leaves out): each compiled or approved year's four statements are drawn before the share and
  after, and must show the same figures line by line. The early check of who may bring one in
  answered someone without the practice's clients differently for a client that exists: they're
  refused at the door as for any route, and the check uses the route's own not-found. The words
  say which address stays (the one in Settings and on the trading names), that a trip's reason
  goes, "whoever signs them for the business" rather than the directors (sole proprietors and
  partnerships), and the computer as well as the phone. Tests: a renamed account in a compiled
  year (`share-check.test.ts`), the same refusal at the door for a client that is or isn't there,
  a code taken from one of Shap's own accounts, and the words.

### The five reviews of 1.29.1 (the Shap Accountant terms of use; before release)

The owner's decision: a practice's indemnity of OpenWorks, and what else only a practice takes on,
go in terms of their own (openworks.co.za/shap/accountant-terms: Shap's terms as Part A, adapted
for a practice, and Part B), accepted by the practice's owner, so Shap's own terms don't change and
nobody else accepts again. Five separate agents reviewed `b77d7a0..7885f0b` and the website's
`accountant-terms.md`.

- Security and privacy, with the penetration test: the penetration test switched Shap Accountant
  on without accepting the new terms, so CI's audit job would fail and the walls between clients
  go untested: it accepts them first (and `accountant-terms.test.ts` checks it does). Staff who
  see only names and pickers got no `accountantTermsVersion` in `/api/reference`, so Practice asked
  them for the terms for ever: it's there now. A client backup's download link worked with the
  terms out of date while the list and link didn't: all three now need Shap Accountant on, and not
  the terms (below). Nothing got past the terms: every practice route but `here`, `leave`, `terms`
  and the backups refuses until they're accepted, sessions already in a client are taken back,
  and switching it on any other way is refused.
- IFRS for SMEs and company law: clause 9.3 had whoever signs approving a client's statements; the
  law has a company's board (s30(3)(c)), a close corporation's members with at least half the
  members' interest (CC Act s58(3)), a trust's trustees, the partners, the owner, and Shap checks
  only that the name is one named in the details: said so in the terms, the points and the docs.
  The public interest score, with the audit or review it points to, is called an estimate; the
  accounting officer's and directors' reports are listed with the compilation report; Shap prints
  the compiler's details as entered; company records are kept seven years (s24; the docs and the
  disclaimer too). Left for the next release, in Shap and Pocket together: the compiler's report is
  headed "Independent compiler's report" whatever the compiler's independence (ISRS 4410 doesn't
  ask for it): "Practitioner's compilation report".
- SARS and tax: no figure changed. Clients' backups couldn't be downloaded until the terms were
  accepted, though the law asks the records be kept and the terms put that on the practice: the
  backup routes check only that Shap Accountant is on, and Practice shows the owner each client's
  backups while the terms wait (`GET /api/practice/records`). Clause 9.4 now has each person in the
  practice who must be registered as a tax practitioner (TAA s240), and the practice's authority
  from each client; 3.2 keeps the practice's own registrations and the list of taxes; 3.4 and 10.1
  where and how long records are kept (TAA s29 to s32, s30 for records kept abroad); the points
  say the tax figures are estimates and that Shap files nothing.
- Accounting and arithmetic: no figure moves on upgrade (a 1.29.0 practice with a kept, an
  imported and a Pocket client, every table and balance compared), a signed year stays signed, and
  the practice gets back in once its owner accepts. Monthly invoices in a client's books are still
  made while the terms wait: kept so (a later catch-up could land in a month closed since), and the
  words that said the books were untouched now say so. Left for later: CI's upgrade job checks only
  the demo company's database, not a practice's clients'.
- Words on screen and liability: the tick's line, the changelog and the docs described the
  indemnity more narrowly than clause 13.1, and point 4 left out a breach of the terms: they all
  say what 13.1 does (`ACCOUNTANT_TERMS_MEANS`, under both ticks and in the share's confirm). 13.1
  says plainly that it covers a claim that Shap, or OpenWorks' negligence, caused the loss (an
  indemnity covers negligence only if it says so), and 13.2's carve-out covers OpenWorks' people as
  13.1 does (CPA s51(1)(c)); 13.3 is clearer on notice, defence and settling. Clause 1.2 said
  OpenWorks doesn't host and then that it might: a separate hosting agreement governs the hosting,
  the backups and OpenWorks' role as operator, 4.1, 4.2, 10.1 and 11.2 apply subject to it, and 8.3
  includes it. Part A says it's Shap's terms adapted, applying in their place for the practice. The
  duties on the practice are in bold; the ticks read "I'm authorised to agree" and record the
  owner's acceptance in a client's books. A test holds `ACCOUNTANT_TERMS_VERSION` to never be older
  than `TERMS_VERSION`. Whether the Consumer Protection Act makes a small practice a consumer here
  (and so clause 13 presumed unfair, regulation 44(3)(e)) is for an attorney: the owner is asked to
  have clause 13 read. The same hosting tension is in `terms.md` 1.2, for its next version.

Tests: `test/accountant/accountant-terms.test.ts` (the backups and monthly invoices while the terms
wait, the staff view, the words and the indemnity's scope, the pentest accepting first), each
failing without its fix.

### The five reviews of 1.30 and Shap Pocket 1.11.1 (Shap Accountant, phase 4: clients on their own Shap; before release)

A business on its own Shap links its accountant's practice: the owner chooses what the practice
may do there and makes a link that works once; the practice's server redeems it for a credential,
then asks the client's Shap for one-time sign-ins for its people and for what its checks find.
Five separate agents reviewed `bf3c6e5..74b7a13` and the website's `a909307..6ab57a7`, each with a
real second Shap listening on a port and a made-up one that says what it shouldn't.

- Security and privacy, with the penetration test (0 to fix, 49 OK, run against the server with
  the demo company; this machine has no Docker): every update would have deleted a practice's
  linked clients, as `migrateClients` took any client with no database for an unfinished one: a
  linked client has none, ever, so it stays. A practice's person got an ordinary 30-day session on
  the client's Shap, renewed with use, and nothing took them out when the practice switched their
  sign-in off or took their task away: they're in for `LINK_SESSION_HOURS` (8) at most, never
  extended (auth.ts), and the practice's server asks each linked client's Shap to take out whoever
  may open it less after a change to their sign-in, their tasks or their profile
  (`takeOutOfLinked`), saying who wasn't taken out when it didn't answer. Where the client's Shap
  requires two-factor of everyone, a practice person without it at their practice is refused
  (`person.mfa`). The ten seconds were only for silence: now for all of it. What a client's Shap
  said when refusing reached the practice's screen word for word (any length, anything): only its
  code goes, put in the practice's words (`linkWords`). A credential is 20 to 200 URL-safe
  characters; the link routes read 16 KB at most; a name another server sends is one plain line
  (`plainName`: no control, hidden or reordering characters). More IPv6 forms of private addresses
  are refused (IPv4-compatible and translated, NAT64's local prefix, 6to4, Teredo, site-local), and
  link-local ones (a cloud server's metadata) even with `LINK_PRIVATE`. A sign-in opened where
  someone else is signed in to the client's Shap no longer signs them out (they sign out first),
  and it clears the demo company's and a practice client's cookies. The guards let by only the
  link's own routes, as Fastify matched them (`LINK_PATHS`), not the whole `/api/link/` prefix;
  taking someone out is in the client's audit log. A canary test checks both ways. What held: the
  codes, credentials and sign-ins (256 bits, hashed, single use under eight at once), 51 path
  tricks, DNS rebinding, redirects, the 2 MB cap, and every owner-only route refused to a practice
  person.
- IFRS for SMEs and company law: one finding longer than 500 characters (five long item names in
  one warning) made the practice refuse the whole answer, so its list never showed that client's
  statements or returns: long words are cut to length on both sides (`healthForLink`, the
  practice's schema), not refused. The drawer said "as their owner in Shap" for a linked client:
  `LINKED_LEVEL_WORDS` (staff or its accountant there), and writing up shown as unavailable on a
  compile-only link. A practice's person in the client's Shap read "then you approve them": they're
  told the business approves them there, through its owner; the compiler's report defaults to their
  own name, the practice in its field (`ownName`). Clause 9.3 says the client approves there, and
  the practice neither approves nor records it. Also, from before: an already compiled set could be
  compiled (or a report uploaded) over without keeping the signed one: refused until it's reopened,
  in Shap and Pocket. Approving stays the client owner's (s30(3)(c), CC Act s58); nothing lets a
  linked person reopen a locked period or change a signed year.
- SARS and tax: the returns for a set of books kept and linked are the same in 13 settings. The
  long finding lost the returns too: what they're worked out from is read on its own when the rest
  can't be, and the summary is marked as from before (`stale`); days are real days, the time a
  real time, the dividend days the last 100 distinct. A dividend journalled by hand put no DTR01 on
  the list: it's taken as paid on its day. What stays the owner's is one list
  (`LINK_STAYS_OWNERS`, used by both screens and the docs), with provisional tax paid, profit shares,
  closing VAT periods and the chart of accounts; the refusal of a provisional tax payment says to
  ask the owner, and that a journal isn't counted. The compile level's statements' details and
  small business corporation answer are said. Linking gives the practice nothing with SARS, the
  Department of Employment and Labour or CIPC (the panel, the disclaimer); 10.2 has the practice
  keep its own records of its work and the returns it files (TAA s29); 3.5's backups are of the
  books the practice keeps; docs/SARS.md says where a linked client's returns come from.
- Accounting and arithmetic: a made-up month written up by the practice's person on the client's
  own Shap and the same month kept in the practice agree to the cent (trial balance, statements,
  VAT201, payroll, bills, the bank), every entry in that person's name, the books audit clean, and
  the checks the practice shows equal what the same books give. Wipe all data failed once anyone
  from the practice had signed in (a person's link restored before the link): the links are kept
  with the people, put back after them. The long finding left the practice showing an out-of-date
  summary: marked as from before. Also, from before, in Shap and Pocket: a bank line matched to a
  bill's payment showed as open for good (no label for it in `matchesFor`), and matches accepted
  from the suggestions weren't in the audit log. `security.test.ts` now ends with the books audit.
- Words on screen and liability: "they sign in for that time only" and "Your books stay here:
  nothing else goes" weren't true (8 hours; they can download, print and send in the business's
  name): `LINK_WHAT_GOES` is now points that say what they can do, every field that goes (the keys
  `healthForLink` sends, held by a test), that it goes at linking too, that what was sent stays
  with the practice, that two-factor is required where the client's Shap requires it, and to give
  the link as one would a password and check the practice's name. "Settings → People → Your
  accountant" named a tab that isn't there: "People who sign in", everywhere. An access change the
  client's Shap didn't take was toasted "Saved": who may still be in is said, on Practice and People.
  The panel shows who's been taken out, "last signed in", how to change the level; the bar at the
  top says for how long; an expired sign-in covers unlinking and changed access; errors no longer
  blame the client for what a restore would do too, or show "ENOTFOUND". The accountant terms: 10.2's
  duty, its limit and 12.1's "between your practice and the client" in bold; 10.3 reads a linked
  client's checks as Shap finds them, shown as sent; 11.2 covers a linked client's server; the
  points carry 10.2 and "keeps or opens" as 13.1 does. The version stays 2026-11-17.2 (not yet
  released): practices accept it once. Shap's own terms need no new version (3.1, 3.7, 3.8 and 6.1
  cover it); the disclaimer refers to 3.1 and 3.8 as its Pocket section does. For an attorney: is
  a non-bold "between you and them" in a disclaimer enough; does the CPA reach a free service; is a
  linked practice the business's operator (POPIA s21) or a responsible party of its own.

Tests: `test/review-1.30/` (`data`: a restart, a wipe, the long finding, a stale answer, strict
days, a dividend journalled by hand; `security`: the session's length, taking people out, two-factor,
someone else signed in, the guards' routes, the body limit, plain names, the canary, the client's
words, the deadline, the credential, the addresses; `words`; `accounting`: the month both ways),
`financial-statements.test.ts` (not compiled over), `accounting.test.ts` and `bank.test.ts` (the
bill's payment matched, the suggestions in the log), and in Pocket `accounting`, `bank` and `sales`;
each fails without its fix.

The fixes, checked by the same five agents (`74b7a13..085c4ac`, the website's `6ab57a7..f034db2`,
Pocket's `2b01e84..4b647ef`): every finding fixed, and these found in the fixes. The penetration
test expected an unused sign-in where the owner is signed in to go to `/?link=expired`: it expects
`/?link=signed-in` there now (0 to fix, 49 OK, rerun). `LINK_PATHS` was compared with the path
when no route matched, so a signed-out `POST /api/link/enter` (no such route) had its whole body
read: only the route Fastify matched counts now. A client's Shap answering `null` gave the practice
a 500: anything but a JSON object is `link_answer`. AWS's IPv6 and Alibaba's metadata addresses,
and 169.254.169.254 written as an IPv4-compatible, translated, NAT64, 6to4 or Teredo address, were
reachable with `LINK_PRIVATE`: every form's IPv4 is read and judged as itself. A password or
two-factor reset, or someone changing their own password, took them out of the practice's sessions
but not a linked client's: now both. A dividend journalled by hand and undone in the month still
listed a DTR01: a month counts only when its hand journals come to a dividend paid; and the 100
days looked back missed a DTR01 still on the list (from before 1.30, kept clients too): it looks
back to the start of the month before the list's 45 days. A first answer that couldn't be read lost
the returns: they're kept, and the card says they're all that was read (`unread`). A compile form
on a client whose details hold its last accountant's would have filled them in for the practice's
person to sign: they start from their own (`compilerDefaults`). Words: the IP address and browser
are kept, not shown; the practice works within what the owner allows, not as the owner could; it
must have two-factor on at the practice (its Shap says so), which the hosts list says goes; what
the practice was sent stays on its server (Shap gives it no way to delete it, so nothing says it
can); reopening is the owner's, said to anyone else; the directors approve, signed by the owner;
the chart of accounts is under Lists. The accounting check ran the wipe on a practice with a kept
and a linked client, the test server's wipe on a client's own Shap (twice, and after unlinking), and
found the bank amounts for bill payments are only shown, never totalled; three loose ends, closed:
the stale mark is one statement and never over a summary saved since the checks began; a client's
Shap that can't be reached marks what's shown as from before too; and a kept client's findings are
cut to length as a linked one's are, so the two lists say the same (`findingsForList`). Known, as for kept clients: one person from the practice has
one user on the client's Shap, so opening to compile turns their open write-up tab read-only, and
the other way round. Shap Accountant switched off leaves its people in a linked client's Shap until
their sign-in ends (8 hours at most). Tests: in `test/review-1.30/` (`security`, `data`, `words`),
each failing without its fix.

### The five reviews of 1.31 and Shap Pocket 1.11.2 (Shap Accountant, phase 5: engagement letters and working papers; before release)

A practice drafts each client's engagement letter from the client's details, sends it itself and
records its acceptance, and keeps working papers for each of the client's ended years (review
notes, the trial balance ticked as prepared and reviewed, the year's sign-offs): its own records, in
its own database, checks and never locks. Five separate agents reviewed `da50f5f..7d0769b` and
Pocket's `4b647ef..a9e66f6`, each drafting every letter (each kind of business, each service, kept,
Pocket and linked) and reading them. None said it was ready.

- Security and privacy, with the penetration test (0 to fix, 49 OK, against the server with the
  demo company): a tick put the account's code and balance in the practice's audit log, which its
  owner and accountant read whether or not they were given the client: the log keeps the year and
  which tick, nothing of the account. A letter's words weren't safe from two people at once (in 4
  of 9 tries a sent letter's words changed, or a sent letter was deleted): each change asks for the
  status it expects, and a trigger (`practice_letter_kept`, raising `SH001`) refuses a change to a
  sent letter's words, parties or acceptance, a step back, or deleting it but with its client. A
  4.8 MB letter took 20 seconds to make its PDF, the server doing nothing else: 60,000 characters at
  most, a year 200 review notes and a note 30 replies. An archived client's letters could be
  deleted and ended. A photo of a signed copy went up as taken (where, and on what): made smaller
  and re-encoded first, and the "too big" answer gives the route's own 6 MB. The penetration test's
  rubbish ran with Shap Accountant off, and never tried one client's letter or note under another
  client's address: it does both now (`paperWalls`). Downloading a letter or its signed copy is
  logged.
- IFRS for SMEs and company law: the letter (and terms 9.3, the points, the docs and a test from
  1.30) had a close corporation's statements approved by members holding "at least half" of the
  members' interest: s58(3) says at least 51 per cent. A sole proprietor's, partnership's or trust's
  statements are special purpose (note 1: for them and SARS), but neither the letter nor the report
  said so: the letter does, and the report has Illustration 2's paragraph (para 40(j)), in Shap and
  Pocket. Addressed to a company's shareholders or a co-op's members, the report said "you" for what
  the directors provided (para 40(c)-(d)): it names the directors, and the letter names the
  addressee (para 40(b)). The audit or review sentence said "instead" for a company (an audit or
  review is in addition, a separate engagement), nothing for an NPC (always needs one), a CC (s58(2A),
  Regulation 28) or a co-op (s47, by category). The accounting officer's paragraph is sections 59 to
  62 as they are (checked against the Act). A replaced or ended letter gave a year the wrong
  record: a letter covers the years from its first, accepted, until the last year it covers when
  it's ended (`last_year_end`, chosen when ending it); the latest covering a year governs it, and
  only it needs that year's second look (`letterStanding`). The file is an aid towards para 38, not
  the whole of it: it shows the statements' compile and approval dates and says to keep the final
  set and report with it (38(c)). The list warned about compiling for a client the practice doesn't
  compile for: "not for compiling", no warning. A partner's sign-off without a review is said. "We'll
  tell you of any we come across" gives way where the law asks (FICA s29(3)). Grammar for one owner.
- SARS and tax: an approved PBO's letter had the ITR14 and provisional tax (it's the IT12EI, and no
  provisional tax), a turnover tax client's the ITR14 or ITR12 and IRP6 (it's the TT02 and TT03):
  the letter reads the client's own settings, or what its linked Shap sends. Section 240 was said
  only with income tax, and only for filing: a "Dealing with SARS" part comes with every tax
  service (who completes, helps complete or advises; eFiling authority for the tax types chosen,
  withdrawable; SARS's letters straight away, an objection within 80 business days; penalties and
  interest). Payroll: UIF and SDL where they apply, UIF to the Fund where not registered with SARS,
  the Department of Employment and Labour's declarations, the IRP5 and IT3(a) certificates, and
  labour law the client's. A partnership's each partner's own; a trust's IT3(t); a company's DTR01
  only if listed. Records: five years from each return, longer during an audit (s29, s32), seven
  under the Companies Act for companies only (it said so for a CC and a co-op too). Confidentiality
  gives way where the law asks (TAA s46).
- Accounting and arithmetic: a change of year-end month made every older year's papers refuse
  (400), and in reverse the whole page; a year that has papers, is closed or has statements stays
  open, its trial balance over its own twelve months (`trialBalance`'s `from`, `yearStartOf`), and
  the page opens on the latest year that does. The compile form said "signed off" when the books
  had moved since: the statements route hashes the trial balance and each sign-off says if it's
  changed (`changed`). Ticks and the hash went by the account's code: a new code dropped the ticks
  and said "changed", a code taken by another account carried them over, and an expense moved to
  assets wasn't a change: ticks are the account's own (`account_id`), the hash is each account, its
  type and its balance, and each sign-off keeps the rows it was given against (`tb`). The test
  depended on the real date (three tests red from 1 March 2027): its clock is fixed. A client whose
  books hadn't reached a year end was offered four years before them: none, and a new letter starts
  from this year's end or the next. The trial balance has its debit and credit totals, on screen
  and in the PDF. A note opened again took back sign-offs unlogged, and a note raised after them
  took nothing: both take back the review and the partner's, each logged, said in a confirm.
- Words on screen and liability: a sent letter wasn't kept as it is, as the screen said: its PDF
  read the practice's and client's names afresh, and the client's two names didn't agree. The
  parties are kept on the letter (the practice's legal name, registration number, trading name and
  address; the client's legal name), changed with the draft, kept once sent; the letter's words name
  no party ("the practice named above"). Practices were led to send the draft: it's headed "Draft,
  to read: not for sending" with `LETTER_NOTE` on it (the sent one brings in nothing of OpenWorks),
  marking it as sent asks first and says Shap doesn't send it, and the changelog and docs say so in
  that order. The letter promised to delete what Shap can't, and picked the practice's POPIA role:
  confidential and secure, and when it ends their books go back, keeping only what the law and the
  practice's body ask. `LETTER_NOTE` says the draft is not complete and not checked against the law
  or the practice's body's rules, to check it (and an attorney, for anything legal), and is in the
  drawer where the words change. A Pocket client's letter offered to write up the books they write
  up themselves. "Compiler's report" on the screens is the compilation report (Shap and Pocket);
  the changelog and docs say the letter is drafted to cover para 24, not that it does, and "as its
  example reports title it". Smaller: one name for the page, the hints, the messages (before the
  day it was sent; "or an owner"; a company's accounting officer), "Recorded as accepted", End's
  confirm. The accountant terms: 9.3 at least 51 per cent; 9.2 names the drafted letters and the
  working papers among the aids (not complete, not legal advice, not checked against the law or
  the body's rules, their terms between the practice and the client); 11.1 the practice's own
  records about its clients; 13.1(b) Shap Accountant with its letters and papers. So
  `ACCOUNTANT_TERMS_VERSION` is 2026-11-17.3: practices accept once more; Shap's own terms don't
  change, and the disclaimer's practices section says it in a sentence. (Section 7's record of 1.30
  above says "at least half": it was wrong; 1.31 corrects it everywhere it's said.) For an attorney,
  with 1.30's questions: the letter's wording as a starting point, the POPIA role of a practice
  keeping a client's books, and whether drafting the letter for free raises the Legal Practice Act
  (section 33 reserves court work, not contracts).

Tests: `test/review-1.31/` (`letter`: the law and wording of every kind of business and service;
`report`: the report for a sole proprietor, a trust, a partnership, a company, a co-op and a CC;
`papers`: the parties kept, the trigger, two at once, the caps, the coverage, the year-end month,
ticks by account, the compile form, sign-offs taken back, the audit log, books not yet at a year
end; `words`: the screens, the changelog and docs), `accountant/working-papers.test.ts` (its clock
fixed, ticks by account, the archived client's letters), `accountant/accountant-terms.test.ts` (51
per cent), and in Pocket `shap-1.31-report.test.ts`. Each fails on the code as reviewed (run on a
worktree of `7d0769b`, and of Pocket's `a9e66f6`, with only the new tests copied in), but for one
whose fix is on the screen (the list's "not for compiling", which `words` checks). The penetration
test with its new checks, against a production-mode server with the demo company: 0 to fix, 52 OK,
nothing in the server's log at error level.

The fixes, checked by the same five agents (`7d0769b..9a2bb60`, Pocket's `a9e66f6..bf45da7`, the
website's `a6365cf..c1eaf45`): every finding fixed. SARS, IFRS and accounting said ready; security
and words not yet, for what the fixes brought:
- Security: the year's file could still hold 25 million characters (200 notes of 4,000, each with 30
  replies), its PDF freezing the server for 20 to 50 seconds: a year's notes and replies run to
  200,000 characters all together (`YEAR_NOTES_MAX_CHARS`), and at that, in unbroken words, the PDF
  takes well under the test's three seconds.
- Words: the "Dealing with SARS" part said for every practice that its people are registered tax
  practitioners: it says so only when the practice ticks that it's so (terms 9.4 leaves it to the
  practice). The confirms said the sign-offs a note takes back come back by themselves: whoever gives
  them signs again. "Duties as the Act has them": drafted from sections 59 to 62. "Keeping only what
  the law asks" still sounded like deleting the rest: "and keep what the law … asks us to keep".
  Smaller: the notes cap counts cleared ones, the day it was sent reads as a date, a Shap Pocket
  client's books never went anywhere, a letter isn't sent with no practice named, and on the website
  11.1's two brackets are one and the disclaimer's "its working papers" is the practice's.
- Low, done too: a partnership on turnover tax listed returns of its own (each partner's); a turnover
  tax client's statements were "for income tax"; a company on turnover tax lost the DTR01 sentence
  (s64F's exemption has a limit); a trust's statements are for its trustees, its beneficiaries and
  SARS (note 1, the letter, the report; Shap and Pocket); the accounting officer's appointment is
  registered in an amended founding statement (s15, s59); a tick says when its account changed kind,
  not only balance; the PDF's difference is shown as an amount; and the practice's list says when
  the books had moved since a sign-off, from the trial balance's fingerprint the client's checks
  keep (`tb`, by the database's clock as the sign-offs are, and never sent over a link). The
  report's "As noted in note 1, … described in note 1" stays: it's Illustration 2's own words.
Tests: in `test/review-1.31/` (`letter`, `papers`, `words`, `report`) and Pocket's
`shap-1.31-report.test.ts`, each failing on `9a2bb60` (Pocket's on `bf45da7`).

Checked again by the same five (`9a2bb60..1eb2b1b`, Pocket's `bf45da7..6722b74`, the website's
`c1eaf45..49b5303`): all five ready. Two low points, done before release: notes and replies sent at
once could pass the year's cap together (8 to 24 of 80 got through, and the refusal said "-28 000
left"): each note and reply is counted and added in one transaction, the client's year locked
meanwhile (`pg_advisory_xact_lock`), and a full year says "none left"; and the DTR01 sentence for a
company on turnover tax now says turnover tax exempts the first R200 000 of dividends a year (s64F),
so it isn't read as no return being due for those. The year's file at the cap in unbroken words
rendered in 1.7 to 4.2 seconds on a machine loaded at 5.7 on two cores, the server answering again
as soon as it was done; the penetration test gave 0 to fix, 52 OK. Tests: `papers` (notes and
replies sent at once), `letter` (the DTR01 sentence), each failing on `1eb2b1b`.

### The five reviews of 1.32 and Shap Pocket 1.11.3 (Shap Accountant from the first-run questions; before release)

Setup asks an accounting practice whether it keeps its clients' books in Shap, checks the server
(each client's books are a database), makes the practice's people at the end and accepts both sets
of terms; shap-ctl gains a `practice` step (CREATEDB for the server's own Shap's login). Five
separate agents reviewed `b61eef0..4d384b2`, each walking setup as a practice (the words review in
every state of the server's panel, with Playwright). None said it was ready.

- Security and privacy, with the penetration test (0 to fix, 51 OK): shap-ctl's backups split the
  databases' names on spaces and wrote each dump at `<backups>/<name>-…`, so a login that may make
  databases (which this change gave test servers) could name one to overwrite another company's
  backup with its own books, or have root write outside the backups: the names are read one a line,
  only those Shap makes (`^shap(_[a-z0-9_]+)?$`, not a demo), checked in SQL and again in bash.
  shap-ctl no longer gives test servers CREATEDB on its own (add-company.sh `--test-server` does, at
  the operator's say-so; one command for an older one). Its `practice` step gave a hardened login
  CREATEDB whenever any owner asked, with Shap Accountant off and on a server real companies share:
  it refuses while any added company isn't a test server, and the app asks only with Shap Accountant
  on and its terms accepted (the end of setup, or Practice's button), never with other companies'
  books on the server. No root-side opt-in: on a server no other company shares, the server's own
  Shap already holds everything on it. A test server could make clients' databases without end
  (12 MB each, backed up nightly, on a server real companies share): 10 at most. Two team requests at
  once both found nobody else signed in: made under an advisory lock, checked again inside, a
  duplicate name 409 (not a 500); and a profile anyone is on, signed in or not, isn't changed by it.
- IFRS for SMEs and company law: the Bookkeeper profile read as someone who compiles, and compiling
  signs the compilation report (a CC's accounting officer's report, s62) in that person's name: it
  writes up, and Who opens it says compiling is signing (`COMPILE_SIGNS`). Time tracked up to the
  year end and not invoiced by then wasn't flagged, while the policy said all work is invoiced as
  it's done (23.14): a look item with its value at the rates, and the policy worded to fit, in Shap
  and Pocket. A practice's revenue note showed "Project revenue – labour" and an "Other income" row
  inside revenue: its revenue accounts are named Fees, Recharged costs and Other revenue while unused.
  Its client costs went under Parts: "Costs recharged to clients", Parts hidden. The nature of the
  business says "accounting, bookkeeping and tax services". Noted, not changed: amounts paid as the
  client's agent still run through revenue and costs (the docs say so, netting is the practice's
  call); a practice's own statements compiled internally isn't defaulted.
- SARS and tax: setup let an accounting practice stay on turnover tax, though more than 20% of its
  receipts from a professional service ends being a micro business (Sixth Schedule para 3(b), para
  1's list): choosing it switches turnover tax off and says why, and setup, Settings and the
  cautions say the rule for the other professional kinds (Pocket too). An "Expenses" line invited VAT
  on a fee paid as the client's agent (s54(2)): the practice's item for it comes without VAT, the
  exempt option's hint says when, and the line is "Recharged costs". The SBC caution shows for a
  practice (s12E(4)(d)), the practice's caution says completing returns for a fee needs registration
  as a tax practitioner (TAA s240), and the industry hint says the checks are aids.
- Accounting and arithmetic (setup through the API as `finish()` does, both sets of books audited,
  the made-up practice's VAT201s and EMP201s checked against its ledger): a retried setup whose team
  was made but whose answer was lost was stuck: it asks first and doesn't send it twice. The rent
  check missed the new trade, choosing another kind after a practice kept its "no sales", and the
  made-up practice paid another bookkeeper: fixed. A matching cost type Shap had already is listed
  first. Unchanged: earlier kinds' cost types stay on (as before).
- Words on screen and liability: Practice said "Shap is asking" when nothing had been asked, and on
  an added company's server the panel told the operator to give its login CREATEDB, beside the words
  saying it mustn't: one set of words per state, the command never on a shared server, "Ask the
  server" where Shap may. "Shap gets this server ready", a tick saying the server "can keep your
  clients' books" and "who can reach them are your practice's alone" read as promises: Shap checks
  and asks, the server's security and backups are the practice's to look after (the Shap Accountant
  terms 3.7 and 10.1 already say so: no terms change). "Or your own PC" pointed at deploy/test (for
  testing, no backups): a computer only the practice uses. "Settings → System" is "Updates &
  backups". The request went before the terms were accepted: it goes at the end, after both. Smaller
  words: shap-ctl's messages name whose login and log why, "their name", payroll comes next.

Tests: `accountant/practice-setup.test.ts`, `ctl-script.test.ts` (failing on the reviewed script,
which wrote outside the backups), `review-1.32/reviews.test.ts`, `test-server.test.ts`, and Pocket's
`shap-1.32.test.ts`, each failing without its fix.

The check of the fixes (`7ea0657`): SARS ready. Still to fix, and fixed: a test server's 10-client
cap could be got round by adding clients at once (22 of 24 got in): counted under an advisory lock,
rows or databases; a test server could make another company's `shap_<name>_demo` first and set it up
to run its own code in that company's sessions: a demo database another login made is never used.
"Write up" also opens a client to compile, so compiling isn't only for those given it: said, and who
may sign is the practice's to decide (the words review: not Shap's advice). Time put on a quote and
invoiced from it counted as never invoiced, and earlier years' time never invoiced was listed every
year: the quote's invoice counts, and only the year's time (and earlier time invoiced after the year
end) is listed, in Shap and Pocket. The agent's amount still went into revenue, whatever the docs
said: there's no invoice item for it (an invoice line is revenue), and the docs say IFRS for SMEs
23.4 keeps it out. The cost of recharged costs is named for a practice too, and another kind chosen
while unused puts Shap's names back; move-in puts a practice's materials under its own cost type.
Words: the busy state asked the server in a loop (2,521 requests in 30 seconds) and then said "too
many requests": it asks every 15 seconds at most; setup's failed state offered a button that Shap
Accountant (not on yet) refused: none in setup, and Shap asks again at the end; a test server made
the practice's own server look shared, unlike shap-ctl: shap-ctl counts the added companies (real
and test) into its status, and the app goes by that where it has it; the s240 sentence has its
exceptions; "Settings → Features" is "What you use". Smaller: curly apostrophes in shap-ctl's
messages, "busy with another request", less than 0.1 hours, "usually" for the SBC caution, the
investment income in the turnover tax rule, the turnover note only while it's off.

The third round (`af643c7`): SARS ready again. Still to fix, and fixed: a client's database dropped
(or part-way through a restore) and made again by another login that may make databases was still
migrated and opened, its code running as this Shap's login (Postgres's superuser on the default
install): only a database this Shap's own login owns is migrated or opened (checked from the
practice's own database, never the client's), in setup, requests, the checks and monthly invoices;
the unbilled-time query searched every invoice for each time entry (6 000 of each: 2 to 7 seconds,
in every statements view and the practice's checks): a join, milliseconds, the same in Pocket; a
company added since shap-ctl last counted wasn't seen as another company: shap-ctl names the test
servers' databases and the app counts every other one; the exempt option's hint told people to put
an agent's amount on an invoice line: it says it's neither supply nor revenue and doesn't go on the
invoice; a refusal over other companies since gone stayed on screen: it reads as never asked. The
cap's pattern is `starts_with` (CodeQL flagged the hand-escaped LIKE). Smaller: "whichever way
someone is given a client", the law as well as the professional body for who may sign, the agent
line in the changelog hedged, move-in's cost types in order.

The fourth round (`0ccef71`): security (the penetration test: nothing to fix), IFRS, SARS and
accounting ready. Words, still to fix, and fixed: the exempt hint said flatly that an agent's
amount is neither supply nor revenue: it says "generally", gives Shap's own limit as the reason it
stays off a Shap invoice (Shap counts every invoice line as revenue) and says to check with an
accountant, in both apps and their changelogs; the refusal of a client's database owned by another
login gave the command to hand it over with no warning: it names that login, says to hand it over
only when you know where it came from (and otherwise to find out who made it), and ACCOUNTANT.md
says why; the refusal of a missing database says it's restored from the server's backup.

### Code scanning (CodeQL), first run

- The Accounts screen's download links carried the period's dates unencoded (flagged as text
  that could become HTML): encoded now.
- A pattern tidying registration numbers could backtrack on a long run of spaces: replaced.
- "File data sent out": the version number, read from package.json at run time and sent with
  feedback, market rates and the tests' requests. Built in at build time now.
- Shap Pocket: its engine's router let a query parameter called `__proto__` reach the query
  object's prototype; its database worker would load the empty books from any address the page
  gave it, and didn't check where a message came from. All three fixed.
- Test code, test tools and the clip recorder are left out of the scan (they read files and call
  a local test server on purpose).

