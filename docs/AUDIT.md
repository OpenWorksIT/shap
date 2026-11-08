# Shap's audit: security, safety, privacy, penetration and the books

Shap holds a business's money and its people's details, so every change is checked before any
server can take it, every server checks itself, and the books check themselves. Modelled on
Steady's (OpenWorksIT/steady: `docs/UPKEEP.md`, `deploy/audit-server.sh`).

## 1. Every change (CI, `.github/workflows/ci.yml`)

Runs on every push and pull request. When **all** of it passes on `main`, CI moves the `stable`
branch to that commit. Servers update only from `stable` (`deploy/vps/ctl/shap-ctl.sh`), so a
change that fails anything never reaches a server.

| Job | What it checks |
|---|---|
| **test** | Type checks; every test, among them: |
| | **Accounting**: the VAT, payroll, tax, year-end, bank and bill rules (`year.test.ts`, `vat-lines.test.ts`, `payroll.test.ts`, …), each suite ending with the books audit finding nothing to fix (`expectCleanAudit`) |
| | **The books audit itself** (`books-audit.test.ts`): clean books pass; books broken on purpose are caught |
| | **Security** (`security.test.ts`, `hardening.test.ts`, `auth-races.test.ts`): password and code guessing, stolen sessions, cross-site requests, files that aren't what they say, spreadsheet formulas, what each role may do on every route |
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
force-pushing it, so it can only move forward; nobody moves it by hand (CLAUDE.md). Every action a
workflow uses is pinned to a commit (Dependabot moves the pins).

## 2. Every server, every 6 hours (`deploy/vps/audit-server.sh`)

The `shap-audit` timer runs it (installed by `ctl/install.sh`, or by the updater itself on its
next run) and after every update. It changes nothing. Its results show in **Settings → Updates &
backups → Checks**: SSH, the firewall and what listens (the database and the app never on the
internet), automatic security updates, disk space, who may change Shap's code (files and folders)
and read its secrets (`.env` and each company's) and backups, the containers, backups (recent,
sound, not readable by others, copied off the server), each site as Caddy serves it
(certificate, HTTPS, headers) and whether it's found by its public name, two-step sign-in, a
waiting update or a failed check for one. Anything it can't check is a WARN saying so, never an
OK. It holds nothing of any company's books, so every company on the server may see it.

The updater (`ctl/shap-ctl.sh`) takes only `stable`. If it can't fetch it (no network, GitHub
down, the branch gone), nothing is updated and Settings says why; it never falls back to `main`.

Run it by hand any time: `sudo /opt/shap/deploy/vps/audit-server.sh`.

## 3. The books, any time (`apps/server/src/audit/books.ts`)

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
  Shap's own figure for each account is kept when the year is agreed and compared (worth a look
  while the year is open; wrong once it's closed). For years agreed before 1.21.1, from that
  update on. Old years not yet agreed are flagged;
- documents add up; while registered for VAT, tax invoices carry what SARS requires; credit notes
  say why; no invoice number went missing without a deletion in the audit log;
- VAT claimed has its slip; no cost claims more VAT than it can hold (the rule a cost is saved by:
  the VAT the amount includes at the rate on its date, and a cent for the supplier's rounding);
  everyone paid has an ID and tax number for their IRP5;
- the database's own safeguards are there (the audit log can't be changed, journals must balance).

## 4. Before each release (the version goes up)

1. CI is green on the commit, all four jobs (and `stable` moved to it).
2. An **independent review** of everything since the last release, by someone (or a separate
   AI session) that didn't write it: security, privacy, the accounting and SARS rules, data
   safety on upgrade. Findings fixed, each with a test.
3. vps1 updates; `sudo /opt/shap/deploy/vps/audit-server.sh` shows nothing new; the books audit
   on its companies shows nothing new.
4. The changelog says what changed, security fixes included once servers have had a chance to
   update (SECURITY.md).
5. Shap Pocket shares the accounting: the same fixes go there, with its tests.

## 5. Once a month

- [ ] Dependabot's pull requests and the latest dependency check: take what's worth taking (each
      goes through CI).
- [ ] `.github/accepted-advisories.json`: anything accepted that can now be fixed, or that's due.
- [ ] The repository's Security tab: code scanning, secret scanning, Dependabot alerts.
- [ ] Each server's Checks (Settings → Updates & backups): all clear, or each item explained.
- [ ] A backup restored to a scratch machine once a quarter, and opened (`docs/backups.md`).
- [ ] Who has access: GitHub collaborators, deploy keys, the servers' SSH keys.

## What the first audit found (November 2026, version 1.20)

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

