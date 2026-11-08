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
| **audit** | The real server, from its Docker image, read-only, without extra powers, as production runs it, with the demo company: the **penetration test** (`deploy/test/pentest.mjs`: every route as every role, rubbish in every id and body, sessions, sign-in, headers, CORS, files outside the app, oversized requests), the books audit, and no errors or personal details in its log |
| **upgrade** | The previous release's database, brought up to this one: migrations run, the books audit finds nothing to fix, and the account balances that changed are listed in the run's summary (the changelog should say why) |
| **dependencies** | Known vulnerabilities in what the server and web app run (`scripts/audit-deps.mjs`: high and critical fail unless accepted in `.github/accepted-advisories.json`, with a reason and a date to look again); every outside address in the code is on the privacy list (`scripts/privacy-hosts.mjs`, `.github/hosts.json`) |

Also on GitHub: Dependabot's weekly pull requests (`.github/dependabot.yml`), the weekly dependency
check (`dependency-check.yml`), CodeQL code scanning, and secret scanning with push protection
(the repository's Security tab).

## 2. Every server, every 6 hours (`deploy/vps/audit-server.sh`)

The `shap-audit` timer runs it (installed by `ctl/install.sh`, or by the updater itself on its
next run) and after every update. Read-only. Its results show in **Settings → Updates &
backups → Checks**: SSH, the firewall and what listens (the database and the app never on the
internet), automatic security updates, disk space, who may change Shap's code and read its
secrets and backups, the containers, backups (recent, sound, not readable by others, copied off
the server), each site from outside (certificate, HTTPS, headers), two-step sign-in, a waiting
update. It holds nothing of any company's books, so every company on the server may see it.

Run it by hand any time: `sudo /opt/shap/deploy/vps/audit-server.sh`.

## 3. The books, any time (`apps/server/src/audit/books.ts`)

**Settings → Updates & backups → Checks → Your books** (owner and accountant), or
`node apps/server/dist/audit/cli.js` in the app's container. It checks that:

- every posting balances, document by document, and the quick totals agree with the ledger;
- the trial balance and the balance sheet balance, today and at the last three year ends;
- debtors agree with the open invoices, creditors with the unpaid bills, the VAT account with each
  VAT201 of the last year, PAYE/UIF/SDL with the EMP201s;
- agreed years still show what they were agreed at; old years not yet agreed are flagged;
- documents add up; tax invoices carry what SARS requires; credit notes say why; no invoice
  number went missing without a deletion in the audit log;
- VAT claimed has its slip; no cost claims more VAT than it can hold; everyone paid has an ID and
  tax number for their IRP5;
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
