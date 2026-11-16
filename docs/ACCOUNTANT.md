# Shap Accountant

**Settings → Features → Shap Accountant.** For an accounting practice: the practice's own Shap keeps
its clients' books too, each client in a database of its own on the practice's server, and shows
one list of the clients with what three of Shap's checks found in each and some of the returns
coming up. It's a part of Shap, not another app: every fix, check and SARS update reaches it in
the same release.

Shap is free software from OpenWorks IT, who are not accountants, auditors or tax practitioners.
Shap Accountant is a tool in a practitioner's hands: what its checks find and the dates it shows
are worked out from what's captured in each client's books, and from Shap's SARS tables, which may
be out of date. They're aids, not advice, and not every check or return. The practitioner checks
them. Shap files nothing with SARS or CIPC, and signs nothing.

Switching it on says back what the practice answers for: its clients' backups, who in the practice
opens them, their personal information (POPIA), and checking what Shap shows.

## The clients

**Practice** (in the menu) lists the clients. Each has its own books:

| Kind | Where the books are | In Shap |
|---|---|---|
| Kept by the practice | A database of its own on the practice's server | Now (1.27) |
| Imported from another package | The same, from Xero's, QuickBooks' or Sage's trial balance and general ledger exports | Planned |
| A Shap Pocket share | A read-only copy of the owner's phone books, stamped, the next share marking what changed | Planned |
| Linked from the client's own Shap | On the client's own server; Open signs the practice in to it | Planned |

**Add client** (for whoever may add clients) makes a new set of books named for the business.
**Open their books** puts this browser into them, with Shap's screens; the first time, Shap asks
its first questions about the business (the Welcome), as for any new Shap, but not the two about
sharing with OpenWorks, and the terms are accepted for the practice's use of Shap on these books.
The bar across the top says whose books they are, and **Back to the practice** comes back to the
list.

Inside a client's books, what is the practice's stays the practice's: the server's updates and
backups, its security audit, the people who sign in, feedback, wiping, the demo and the practice
list itself refuse there, and nothing is emailed from them (download the PDF and send it).
Signing out there signs out of the practice too. If a client is archived, or someone's access is
taken away or changed while they have it open, the next thing they do takes them back to the
practice's list.

**Archive** closes a client for everyone (anyone who had it open is taken out); its books stay on
the server, and in its backups. **Bring back** opens it again.

## Who opens which

The practice's owner opens every client, to write up or to compile. Anyone else needs **Open the
clients they're given** ticked (Settings → People who sign in) and the client given to them under
**Who opens it**, either:

- **Writes up the books, as their owner in Shap**: they can do everything the client's owner could,
  reopening closed periods included, and they record the client's approval of the financial
  statements (below). They can also open the books to compile.
- **Reads them and compiles the statements, as their accountant in Shap (read only)**: the
  financial statements, docs/STATEMENTS.md.

In a client's books each person from the practice is there by name, so the client's own audit log
says who did what; they're never taken for the client's own directors. Taken off a client, or
given it another way, they're out of its books at once (open it again, as given now).

**Add clients and choose who opens each** lets someone other than the owner do the adding and
the giving, themselves included, and see every client.

## The financial statements in a client's books

The practice compiles them in Shap, as itself (**Open to compile**): a compiler's report isn't
uploaded in a client's books. Approving them is the client's own: one of the directors (members,
trustees, partners or the owner) named in the statements' details signs, and the practice records
it, uploading the page they signed (**Record the directors' approval**). Shap won't compile until
those who approve are named. In a new client nothing is taken for granted: nobody is named and the
company isn't taken as owner-managed (every shareholder a director) until the practice says so.

Compiling doesn't need independence (ISRS 4410 (Revised) 17(g), A21). Where the public interest
score calls for an independent review, the list says so: the reviewer can't be anyone in the
practice who prepared or compiled the statements (Companies Regulation 29(5)).

## The client's records

The client company stays responsible for its records (Companies Act s24, s28), and records kept
away from its registered office need a notice to CIPC (s25(2), CoR 22). The practice's owner can
download each client's own backups from the list (**Their backups**, with the owner's password),
to hand the books over or keep them. Wiping the practice's own books keeps its list of clients
and who opens each: the clients' books are never touched by it.

## The checks

**Run the checks** (and every time someone comes back from a client's books, if they haven't run
in the last minute) runs three of Shap's checks on that client's books:

- the books audit (accounting and arithmetic, VAT, and the VAT201 figures Shap works out: what to
  fix, what to look at), counting employees rather than naming them;
- the financial statements for the newest year that has ended (none before the books' first year
  ends): where they stand (draft, compiled, approved), whether a signed set still matches the
  books, their checks (IFRS for SMEs and company law) and the books audit at the year end (what
  compiling refuses), the assurance the public interest score calls for, and an earlier year not
  yet approved;
- how far the books are closed (month end, VAT periods, the year).

Home's own reminders (the VAT registration line, SDL, month end due, SARS's tables out of date and
the rest) show when their books are open. The checks flag; they never post anything. Shap sends
nothing from a client's books to OpenWorks or anyone else: no usage note, prices, feedback or
email. Shap uses no AI service on anyone's books.

## The returns coming up

Some of them, from each client's own settings, worked out again each time the list is shown: the
VAT201, the EMP201 (nil ones included, for an employer registered for PAYE), provisional tax
(each partner's own for a partnership, and the voluntary third payment), turnover tax, a company's
ITR14 or TT03, an approved PBO's IT12EI, dividends tax, and the filing season's ITR12, ITR12T,
IT3(t) and EMP501 interim dates. Returns due in the last few weeks show as "was due": Shap can't
tell whether they were filed. Not there: the CIPC annual return (Shap doesn't keep the date of
incorporation) and the Compensation Fund's return of earnings.

docs/SARS.md lists each rule and its source; they're checked with the standard SARS update
(CPDAUDIT.md section 2).

## How it's built

- Each client's database is named `<the practice's database>__c_<12 hex>`, and only the database's
  own login may connect to it. Every client gets every migration when the server starts, one at a
  time; a client whose migrations fail isn't opened until they run. Backups (shap-ctl) take every
  `shap_*` database, so each client is backed up nightly with the practice, and can be restored on
  its own.
- A request reaches a client's database only after the practice's own session, the feature, the
  client (not archived, migrated) and the person's access, as they were let in, are all checked
  (`apps/server/src/modules/practice.ts`); then every query goes there (`db/routing.ts`, as for the
  demo company). A session made in one client's database means nothing in another's, and a query in
  one client's books can't reach another's. The demo company never reaches the practice's list.
- A client's monthly invoices are made on their day, as the practice's are, never emailed.
- The penetration test (deploy/test/pentest.mjs, section 6) tries the walls on every release.
- **The database login must be allowed to create databases** (the default install's is). A
  server set up with a least-privilege login (docs/deployment.md) needs `alter role shap_app
  createdb;` for Shap Accountant. Client databases made by a superuser before a move to
  `shap_app` are handed over with `alter database "<name>" owner to shap_app;`.
