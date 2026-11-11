# Shap Pocket's CPD audit

Shap Pocket keeps a one-person business's books on their phone, and its accountant signs what it
draws up. Like an accountant's continuing professional development, every update is checked the
way the profession would check it before any phone takes it. Pocket shares Shap's accounting code
(`packages/shared`, `packages/engine` from Shap's `apps/server`), so it goes through Shap's CPD
audit ([OpenWorksIT/shap: CPDAUDIT.md](https://github.com/OpenWorksIT/shap/blob/main/CPDAUDIT.md)),
with what's Pocket's own below.

## 1. Every update: the five reviews

Before the version goes up and the update is pushed, the five reviews of Shap's CPD audit, each
by someone (or a separate AI session) that didn't write the change, each finding fixed with a test
that fails without it, here and in Shap where the code is shared:

1. **Security and privacy**: for Pocket, what runs in the app. Nothing server-only in the engine
   (it runs in a web worker, where Node's modules are empty stand-ins: the tests check no engine
   file imports one), the database worker answering only the app's own page and loading the empty
   books only from the app's own file, nothing personal leaving the phone without the owner's yes
   (`.github/hosts.json`, `scripts/privacy-hosts.mjs`), the store builds and what the stores'
   privacy labels say (docs/app-stores.md).
2. **IFRS for SMEs and company law**: the statements, as in Shap (Shap's docs/IFRS.md).
3. **SARS and tax**: every figure in Shap's docs/SARS.md, the same here.
4. **Accounting and arithmetic**: every figure the same wherever it goes, and data safety on
   upgrade: books from the version before open (the migrations, `packages/engine/migrations`) and
   give the same figures, and what was signed stays signed.
5. **Words on screen and liability** (from 1.10): everything the app, its PDFs, its store
   listings (docs/app-stores.md) and its docs say to the owner, read as the owner would read it
   and as someone holding OpenWorks IT to it would, as in Shap's: a free app from people who
   aren't accountants, tax practitioners, auditors or labour lawyers, so nothing reads as advice,
   a promise or a figure to rely on; estimates, checks and reminders say so.

Then CI is green on the commit (`apps.yml`: the typecheck, every test, known vulnerabilities and
the privacy list, and the Android and iPhone builds; `web.yml`; CodeQL), and the changelog says
what changed.

## 2. When SARS changes something

The standard update of Shap's CPD audit (section 2), with Shap's: the tables are in the shared code
(`packages/shared/src/tax.ts`, `payroll.ts`, `vat.ts`), copied here. From 1 March each year the
tests fail until the new tax year's figures are checked (`SARS_CHECKED_TO`), and the home screen
tells the owner when this version's tables end before the tax year they're in.

## 3. What each review found

Shap's CPD audit (section 7) has each review; what was Pocket's own:

- **1.5.1**: the first code scanning (CodeQL): the engine's router let a query parameter called
  `__proto__` reach the query object's prototype; the database worker would load the empty books
  from any address the page gave it, and didn't check where a message came from. All fixed.
- **1.7.0**: the statements' fingerprint used node:crypto, an empty stand-in in the app, so
  uploading the signed compiler's report or approving failed there (from 1.6): SHA-256 in plain
  JavaScript now, and the tests check the engine imports nothing of Node's.
- **1.7.2**: Shap 1.23.2's SARS review and its four reviews (Shap's section 7) apply here: the same
  code, fixed the same way, with the tests in `packages/engine/test/sbc-and-sars.test.ts`. What was
  about staff (provisional tax kept from payroll staff) doesn't arise: Pocket has one person.
- **1.8.0**: Shap 1.24's four reviews (Shap's section 7) apply here: the same code, fixed the same
  way, with the tests in `packages/engine/test/sales-invoices-locks.test.ts` and
  `four-reviews.test.ts`. Locking is the owner's (one person: no task to give); what was about
  staff (a teller's stock history, who reopened the books) and the races on the lock (Pocket runs
  one change at a time) don't arise here.
- **1.9.0**: Shap 1.25's IFRS review (Shap's section 7) applies here: the statements' going-concern,
  later-distributions and stock-on-hand checks, and the statement of changes in equity naming a
  CC's, trust's or co-op's capital, with the tests in
  `packages/engine/test/review-1.9-statements-checks.test.ts`. Shap 1.25's test server (made-up
  books, filled and wiped on a server) is Shap's only: nothing of it is in Pocket.
