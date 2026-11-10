<img src="docs/brand/shap-icon.svg" alt="" width="72" align="left">

# Shap Pocket

**The books for a one-person business, on your phone.** Quotes, invoices, costs with a photo
of the slip, what clients owe you, VAT and your tax estimate, for South African sole
proprietors and small companies. Free, open source, no account, no subscription.

<br clear="left">

Made for the electrician who works alone, the plumber, the designer, the tutor: anyone running
their own business who doesn't want to pay every month for accounting software built for
someone else.

## What it does

- **Quotes and invoices** with your logo, colour and bank details. Send them from the phone
  with WhatsApp, Gmail, Outlook or anything else on it. Turn a quote into an invoice in one tap,
  record payments, see who owes you.
- **Costs**: snap the slip, pick what it was. Import bank statements and tick off what's been
  captured (optional).
- **Jobs** (optional): what a job was quoted, what it cost, what it made.
- **Workers** (optional): a helper's days and pay.
- **Sales** (optional): sell over the counter from a quick item list, take the money, share the
  slip, refund what comes back, make it an invoice for a business customer. (Stock records are
  in full Shap.)
- **The books, done for you**: income statement, balance sheet, assets with wear and tear, year
  end for your accountant, CSV exports, and (optional) the annual financial statements under the
  IFRS for SMEs Accounting Standard, shared with your accountant to compile and sign.
- **Tax**: a provisional tax estimate on SARS's tables (sole proprietor or company), and a
  warning when your income gets near the VAT registration line (R2.3 million from April 2026).
- **Only what you need**: switch off jobs, quotes, workers, bank statements, assets or trading
  names.

## Private by design

Your books live on your phone and nowhere else: there is no Shap server. Nothing is sent
anywhere unless you send it (a quote to a client, a backup to your own cloud drive). You can
lock the app with Face ID, your fingerprint or your phone's PIN.

**Back up** from *Backup*: one file, saved through your phone's share sheet to iCloud Drive,
Google Drive, OneDrive or Proton Drive. Restore it on a new phone from the first screen.

## How it works

Shap Pocket is [Shap](https://github.com/OpenWorksIT/shap) (a self-hosted jobs and accounting
app) without the server. The same accounting runs on the phone: the database is
[PGlite](https://pglite.dev) (PostgreSQL compiled to WebAssembly), the screens are React, and
[Capacitor](https://capacitorjs.com) makes it an Android and iPhone app.

```
apps/web          the app: screens, the engine worker, Capacitor (android/, ios/)
packages/engine   the books: routes, PDFs, PGlite layer, migrations, tests
packages/shared   validation, tax tables, money, dates
```

## Building

Node 22.

```bash
npm install
npm test                         # the books, on PGlite
npm run dev                      # the app in a browser, http://localhost:5173
npm -w @shap/web run build       # then: cd apps/web && npx cap sync && npx cap open android|ios
```

Android builds on any OS (Android Studio, JDK 21). iPhone builds need Xcode on a Mac; the
GitHub Actions workflow builds both on every push. Store releases: [docs/app-stores.md](docs/app-stores.md).

## Licence

AGPL-3.0-or-later, with an additional permission that allows distribution through app stores
(see [NOTICE](NOTICE)). Copyright © 2026 Complete Construction Solutions (Pty) Ltd t/a
OpenWorks IT. Third-party components: [THIRD-PARTY.md](THIRD-PARTY.md).

Not tax or legal advice: check figures with your accountant or SARS.
