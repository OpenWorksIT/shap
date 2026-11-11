# Working on Shap

Shap holds a business's books and its people's details. Every update goes through the CPD audit
in [CPDAUDIT.md](CPDAUDIT.md); follow it. Before the version goes up: the five reviews (security
and privacy with the penetration test, IFRS for SMEs and company law, SARS and tax, accounting and
arithmetic, words on screen and liability), each by a separate agent that didn't write the
change, their findings fixed with tests; then CI green. When SARS changes anything: the standard
update (CPDAUDIT.md section 2, docs/SARS.md).

- **Tests with every change.** A fix comes with a test that fails without it. A test suite that
  builds books ends with `expectCleanAudit` (the books audit finds nothing to fix).
- **New routes** say who may use them: `requireAccess('task')` for what staff can be given (a task
  in `packages/shared/src/access.ts`, docs/PEOPLE.md), `requireRole('owner')` for what is only the
  owner's. The security tests and the penetration test read the routes from the code.
- **New outside addresses** (anything the app sends requests to, or links) go on
  `.github/hosts.json`, saying what goes there and on whose say-so. Nothing personal leaves the
  server without the owner's yes (`test/privacy.test.ts`).
- **Never move `stable` by hand**: CI moves it when everything passes. Servers update from it.
- **Shap Pocket** (OpenWorksIT/shap-pocket) shares the accounting code: the same fixes go there.
- Test and demo data is always made up. Commits are by GoufR42 <tiaan@tedvdm.com>.
