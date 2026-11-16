# Shap Accountant

**Settings → Features → Shap Accountant.** For an accounting practice: the practice's own Shap keeps
its clients' books too, each client in a database of its own on the practice's server, and shows
one list of the clients with what Shap's checks found in each and the returns coming up. It's a
part of Shap, not another app: every fix, check and SARS update reaches it in the same release.

Shap is free software from OpenWorks IT, who are not accountants, auditors or tax practitioners.
Shap Accountant is a tool in a practitioner's hands: what its checks find and the dates it shows
are Shap's own reading of the books and of SARS's tables, which may be out of date. The
practitioner checks them. Shap files nothing with SARS or CIPC, and signs nothing.

## The clients

**Practice** (in the menu) lists the clients. Each has its own books:

| Kind | Where the books are | In Shap |
|---|---|---|
| Kept by the practice | A database of its own on the practice's server | Now (1.27) |
| Imported from another package | The same, from Xero's, QuickBooks' or Sage's trial balance and general ledger exports | To come |
| A Shap Pocket share | A read-only copy of the owner's phone books, stamped, the next share marking what changed | To come |
| Linked from the client's own Shap | On the client's own server; Open signs the practice in to it | To come |

**Add client** (for whoever may add clients) makes a new set of books named for the business.
**Open their books** puts this browser into them, with all of Shap's screens; the first time, Shap
asks its first questions about the business (the Welcome), as for any new Shap. The bar across the
top says whose books they are, and **Back to the practice** comes back to the list.

Inside a client's books, what is the practice's stays the practice's: the server's updates and
backups, the people who sign in, feedback, wiping, the demo and the practice list itself aren't
there, and nothing is emailed from them (download the PDF and send it).

**Archive** closes a client for everyone (anyone who had it open is back in the practice); its
books and backups stay. **Bring back** opens it again.

## Who opens which

The practice's owner opens every client. Anyone else needs **Open the clients they're given**
ticked (Settings → People) and the client given to them under **Who opens it**, either:

- **Writes up the books**: they're the owner in that client's books (everything but what's
  closed inside a client, above).
- **Reads them and compiles the statements**: they're its accountant (read only, and the
  financial statements: docs/STATEMENTS.md).

In a client's books each person from the practice is there by name, so the client's own audit log
says who did what. Taken off a client, they're out of its books at once.

**Add clients and choose who opens each** lets someone other than the owner do the adding and
the giving.

## The checks

**Run the checks** (and every time someone comes back from a client's books) runs every check Shap
has on that client's books, the same ones its own Home and Accounts run:

- the books audit (accounting and arithmetic, VAT and SARS's figures: what to put right, what to
  look at);
- the financial statements' checks (IFRS for SMEs and company law) for the last year that has
  ended;
- how far the books are closed (month end, VAT periods, the year).

The checks flag; they never post anything. Nothing about a client goes to any outside address,
and no AI service reads any client's books.

## The returns coming up

From each client's own settings: the VAT201 (the last business day of the month after the period,
on eFiling), the EMP201 (the 7th, or the business day before), provisional tax (IRP6: six months
into the year and its last business day; turnover tax's two payments on the same days), and a
company's ITR14 (12 months after its year end). Returns due in the last few weeks show as "was
due": Shap can't tell whether they were filed. The CIPC annual return isn't there yet: Shap doesn't
keep the date of incorporation.

The dates come from `packages/shared/src/practice.ts`, on Shap's SARS tables, checked with the
standard SARS update (CPDAUDIT.md section 2, docs/SARS.md).

## How it's built

- Each client's database is named `<the practice's database>__c_<12 hex>` and gets every
  migration when the server starts, as the practice's own does. Backups (shap-ctl) take every
  `shap_*` database, so each client is backed up nightly with the practice, and can be restored on
  its own.
- A request reaches a client's database only after the practice's own session, the feature, the
  client (not archived) and the person's access are all checked (`apps/server/src/modules/practice.ts`);
  then every query goes there (`db/routing.ts`, as for the demo company). A session made in one
  client's database means nothing in another's, and no query can join two databases.
- The penetration test (deploy/test/pentest.mjs, section 6) tries the walls on every release.
- **The database login must be allowed to create databases** (the default install's is). A
  server set up with a least-privilege login (docs/deployment.md) needs `alter role shap_app
  createdb;` for Shap Accountant, or the client databases made by hand.
