# Working on Shap

Shap holds a business's books and its people's details. Every change goes through the audit in
[docs/AUDIT.md](docs/AUDIT.md); follow it.

- **Tests with every change.** Accounting rules, SARS rules, security and privacy each have test
  suites in `apps/server/test`. A fix comes with a test that fails without it. A test suite that
  builds books ends with `expectCleanAudit` (the books audit finds nothing to fix).
- **Before a release** (the version goes up), do section 4 of docs/AUDIT.md: CI green (test,
  audit, upgrade, dependencies), then an independent review of everything since the last release
  by a separate agent that didn't write it (security, privacy, accounting and SARS rules, data
  safety on upgrade), its findings fixed with tests before pushing.
- **New routes** are covered by the security tests and the penetration test automatically (they
  read the routes from the code). Say who may use it: `requireAccess('task')` for what staff can be
  given (a task in `packages/shared/src/access.ts`, docs/PEOPLE.md), `requireRole('owner')` for what
  is only the owner's. `test/access.test.ts` tries every route for every task.
- **New outside addresses** (anything the app sends requests to, or links) go on
  `.github/hosts.json`, saying what goes there and on whose say-so. Nothing personal leaves the
  server without the owner's yes (`test/privacy.test.ts`).
- **Never move `stable` by hand**: CI moves it when everything passes. Servers update from it.
- **Shap Pocket** (OpenWorksIT/shap-pocket) shares the accounting code: the same fixes go there.
- Test and demo data is always made up. Commits are by GoufR42 <tiaan@tedvdm.com>.
