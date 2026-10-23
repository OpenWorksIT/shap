# Security

Shap holds a business's money: its books, its clients and what it pays its workers. We take
reports about its security seriously, and we're grateful for them.

## Reporting a problem

Please **don't open a public issue** for a security problem. Report it privately instead:

- **Email** [info@openworks.co.za](mailto:info@openworks.co.za) with "Shap security" in the
  subject.

Tell us what you found, which version (Settings → Updates & backups shows it, or the `version` in
`package.json`), and how to reproduce it. A proof of concept helps but isn't required.

## What happens next

- We'll acknowledge your report within **3 working days**.
- We'll tell you whether we can reproduce it, and roughly when to expect a fix.
- Fixes go out as a new version; the [changelog](CHANGELOG.md) notes security fixes once servers
  have had a fair chance to update.
- We're happy to credit you in the changelog, or keep you anonymous if you'd rather.

## Supported versions

Only the latest release gets security fixes. Shap checks for updates itself and installs them from
Settings → Updates & backups, so staying current is one tap.

## Scope

In scope: the Shap server and web app in this repository, and the deployment files under
`deploy/`.

Out of scope: problems in a server you run yourself that come from how it's set up (an exposed
database port, weak passwords you chose, an outdated operating system), and reports from
automated scanners without a demonstrated impact.

Please test against your own install or the demo company, never against someone else's server.
