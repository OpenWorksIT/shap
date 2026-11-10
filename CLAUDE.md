# Working on Shap Pocket

Shap Pocket keeps a one-person business's books on their phone. Every update goes through the CPD
audit in [CPDAUDIT.md](CPDAUDIT.md) (with Shap's, whose accounting code it shares); follow it.
Before the version goes up: the four reviews (security and privacy, IFRS for SMEs and company law,
SARS and tax, accounting and arithmetic), each by a separate agent that didn't write the change,
their findings fixed with tests; then CI green.

- **Tests with every change.** A fix comes with a test that fails without it. A test that builds
  books ends with `expectCleanAudit`.
- **Shap** (OpenWorksIT/shap) shares the accounting code: the same fixes go there, and come here.
- **The engine runs in the app**: nothing in `packages/engine/src` imports Node's own modules.
- **New outside addresses** go on `.github/hosts.json`; nothing personal leaves the phone without
  the owner's yes.
- Test and demo data is always made up. Commits are by GoufR42 <tiaan@tedvdm.com>.
