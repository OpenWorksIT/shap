# Shap's CPD audit

Shap holds a business's books and its people's details, and an accountant signs what it draws
up. So, like the continuing professional development an accountant keeps up, every update is
checked the way the profession would check it, before any server or phone takes it: four
reviews, the tests and CI, each server checking itself, and the books checking themselves.
Shap Pocket (OpenWorksIT/shap-pocket) shares the accounting code and goes through the same.

## 1. Every update: the four reviews

Before the version goes up and the update is pushed, four reviews of everything since the last
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

Then:

- CI is green on the commit, all four jobs, and `stable` moved to it (CI moves it; nobody moves it
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
4. The version goes up, with the four reviews, as any update (section 1), and the changelog says
   which figures changed and from when.

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

