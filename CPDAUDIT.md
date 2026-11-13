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
- **1.10.0**: Shap 1.26's five reviews (Shap's section 7) apply here: the same code, fixed the same
  way (migration `043_vat_period_locks.sql`), with the tests in
  `packages/engine/test/review-1.10-vat-period-locks.test.ts` and
  `review-1.10-casual-labour.test.ts`. The first words on screen and liability review read
  Pocket's screens too.
- **1.10.1**: from 1.1.0, Send on a quote, pro-forma, invoice or credit note (on its screen and in
  its preview) failed with "Something went wrong": a `useCallback` for the new PDF preview was
  pasted a second time inside the Send button's action (React refuses a hook there, so it threw
  before the PDF was made, and nothing was shared or marked sent). The type check and the
  engine's tests couldn't see it: the screens had no test. Now
  `packages/engine/test/web-hooks.test.ts` reads every screen with TypeScript's parser and fails on
  a hook outside a component or hook (it fails on 1.10.0's `Document.tsx:290`); Shap's screens have
  the same check (Shap's Send never had the line). Found in use, on a phone. Released before its
  reviews, at OpenWorks' call (Send was broken); the reviews' findings are 1.10.2.
- **1.10.2**: the five reviews of 1.10.1, each by a separate agent, fixed with tests
  (`packages/engine/test/review-1.10.1-send.test.ts`, `web-actions.test.ts`, and more cases in
  `web-hooks.test.ts`); Shap 1.26.1 has the same fixes:
  - IFRS and SARS: Send on a draft invoice or credit note shared a PDF headed "Tax invoice" (or
    "Credit note") asking to be paid, for a supply not in the books or the VAT201, and issuing's
    checks (s20(4), s21(3)) never ran. Send asks to issue it first, and a draft's PDF says "Draft
    invoice" or "Draft credit note", without the payment details.
  - Accounting: Send (and Preview, Open in another app) carried on when the save before it was
    refused, sharing the PDF as last saved. They stop now; `web-actions.test.ts` finds an action
    that swallows its own errors awaited inside another.
  - SARS: the message called a document a tax invoice from today's VAT registration, not its own
    VAT rate as its PDF does: both from the shared `documentName`/`documentHeading`.
  - IFRS and SARS: the delete warning read `sharedAt`, which the API doesn't have, so a draft that
    was shared never warned it had gone out: `sentAt`, typed, through `hasGoneOut`.
  - Words: "Something went wrong" told the owner nothing and lost the cause. One wording
    (`UNEXPECTED`: report it under Feedback, no "try again"), and the error into Feedback's trail;
    checked in every screen. The 1.10.1 entry promised the fault "can't come back" and didn't say
    what to do: it says to send again, and, for a VAT vendor, to check what was issued since.
  - Security and privacy: nothing to fix in 1.10.1 (the share sheet is the owner's yes; the PDF
    goes through a FileProvider that isn't exported). The hooks check now also finds a hook
    imported under another name, called on any namespace, or in a handler named like a component.
  - The fixes, checked by a separate agent: the books' own unexpected error still said "Something
    went wrong. Please try again." (and the screens' fallback too), and its cause never reached
    the trail: now `UNEXPECTED` from `@shap/shared` everywhere, the books send the cause back and
    the screen logs it with the route, and the wording check reads the books too. A voided invoice
    still asked to be paid on its PDF and in the message: only an issued invoice (and a
    pro-forma) asks now (`asksForPayment`). The message's payment lines had no test: they're made
    in the shared `shareMessage` now, tested; Send's wiring (asking first, reloading after "Issue
    and send", `hasGoneOut`) is read from the source by `web-actions.test.ts`. "Asks for no
    payment" overstated it (a draft still shows its due date and terms): "without your payment
    details". `pocket.test.ts` issues an invoice, so it ends with `expectCleanAudit`.
