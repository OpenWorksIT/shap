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
| Brought in from another package | The same, from Xero's, QuickBooks' or Sage's trial balance and general ledger exports | Now (1.28) |
| A Shap Pocket share | A read-only copy of the owner's phone books, stamped, the next share marking what changed | Now (1.29) |
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

## Books from another package

A client who keeps their books in Xero, QuickBooks or Sage (Accounting or Pastel) carries on there;
the practice brings them into the client's books here, period by period, to compile them here
(**Add client** → their books are written up in another package; then, in
their books, **Accounts → From another package**). It's what the working-paper packages do with
the same exports.

- **What to export:** a trial balance at a date, and the general ledger for a period. Xero: the
  Trial Balance and the General Ledger Detail (or Account Transactions). QuickBooks Online: the
  Trial Balance and the Journal report. Sage Accounting: the Trial Balance "As of" the date with
  the box that rolls earlier years' profit and loss into retained earnings ticked ("Summarize
  retained earnings values" in [Sage's help](https://help.sageone.com/en_ca/start/accounting-view-the-trial-balance-report.html)),
  and the Detailed General Ledger, as CSV. Pastel: the Trial Balance and Ledger Transactions.
  Excel (.xlsx) or CSV. Menus differ by version and country (these are as their help pages had
  them for 1.28, not confirmed on every edition): the package's own help says how to export them.
- **Which trial balances the statements need:** the year end's, the year end before it (the
  opening position), and the one before that for the comparatives. Brought in alone, a trial
  balance is the books' first entry: before it, the comparatives, the opening equity and cash, the
  changes in equity and the cash flows start from nil (IFRS for SMEs 3.14, 6 and 7), and the
  statements' checks say so ("The opening position is in the books").
- **How Shap reads them:** by what's in them, not a fixed layout: the heading row among the first
  rows, each column by the names the packages give it, a trial balance (no dates) or ledger lines
  (dates) by its columns, flat or grouped under each account, and the date or period from the
  title. Only rows that are wholly a total or an opening or closing phrase are skipped (QuickBooks'
  "Opening Balance Equity" is an account). A trial balance is read from its year-to-date columns
  (Xero), its closing columns, or its closing balance, and opening, debit, credit and closing must
  add up; plain Debit and Credit beside an opening balance are the period's movements, refused. A
  ledger's dates are read the way round that puts every line inside the title's period, and a line
  outside it is refused. Each day's lines must balance (if not, the export may be missing
  accounts or lines, and Shap says so). Amounts such as "R (1 234.56)" and "1 234.56 Cr" are read as
  credits.
- **Their accounts:** each goes to one of these books' accounts (as last time; the same name, or
  the same code with the same name; or Shap's own account for VAT, PAYE, UIF, SDL, income tax,
  dividends, interest received, retained earnings, share capital, debtors and creditors, so Shap's
  tax figures and control checks are on them) or a new one of the kind their file gives, on the
  statement line their package's type says (a fixed asset, a non-current liability, the bank). A
  code alone never decides it, and an account the file puts on the income statement never goes to
  a balance sheet account here, or the other way round. Only the owner adds new accounts (at most
  500 an import); anyone else chooses one of these books' for each. The choice is remembered, so
  the next period's files map by themselves.
- **A ledger** comes in as its transactions, from the package's lines (dates, references and
  descriptions kept; a transaction's lines on one account are added together, and where Shap can't
  tell a day's transactions apart, they come in as one journal for the day). The same period brought in again replaces it; a period that overlaps an
  earlier one without covering it is refused. Its journals are changed only by bringing the period
  in again, or taken out with it: not one by one.
- **A trial balance** brings what was brought in from the package to its figures on its date: the
  income and expense accounts and the dividends for the year (the year end in these books'
  settings, which the preview shows), the rest to date, and retained earnings to what the earlier
  years left. The practice's own entries here aren't changed: they're added to its figures, so
  these books differ from the package's trial balance by them. After the year's ledger it comes to
  nothing, which shows the ledger's balances agree with it, account by account. A title that gives
  a period starting on any other day than these books' year start is refused (where the package's
  year runs otherwise, check with the client which year end is right; Shap draws statements for 12
  months). A trial balance that would change
  the years before it (retained earnings) says how much, and is refused when those years are closed
  here: a prior-period matter for the accountant (IFRS for SMEs 10.21).
- **Check what it would do:** runs it all and undoes it, to show each journal, what each trial
  balance would move account by account, and how many of the practice's own entries it leaves as
  they are.
- **Brought in again together:** a trial balance brought in earlier was worked out with the books as they
  were, so a ledger or an earlier trial balance under it comes in together with it again, or is
  refused; and nothing under it is taken out while it stands.
- Nothing goes into a closed period, an agreed year or a year whose statements were approved
  (checked on every line's date); it all goes in at once or not at all; agreeing a year end keeps
  what was brought in; **Take out** removes an import and its journals, while the period is open.
  Where these books already have entries of their own in a ledger's period, Shap says so first
  (they'd be counted twice). Each file's SHA-256 is kept with its import, and the activity log has
  each import, each one it replaced and each one taken out, with its file and period (which exports
  the compiled figures came from: ISRS 4410 (Revised) 38(b)).
- **What a file can do to the server:** an Excel file is unpacked here and counted as it's read
  (64 MB at most, whatever its directory says), one at a time, its cells counted (2 million a file,
  4 million a request); a CSV is held to 500 columns and 5 million cells; names are cut to fit.

The figures are the client's package's, as Shap read them: Shap reads the files as it finds them
and suggests where each account goes, and doesn't check them against the package or the client's
records. Compare these books' trial balance with the package's after bringing them in, before
relying on them (the page says so, `IMPORT_NOTE`). Shap's checks (the books audit, the statements'
checks) test only that the books here hang together, not that the package's figures are right, and
a VAT201 or payroll worked out in the other package isn't Shap's to work out or check. A VAT period whose VAT came in from the package says so on the VAT201 screen and in
the tax pack, and the books audit leaves it out of its VAT check and says why. The provisional and
turnover tax estimates project from the last day brought in, and a trust's distributions in the
books brought in are shown, not taken off (Shap can't tell which part is this year's income to
residents: section 25B is the accountant's to work out). Shap's figures are estimates only.

## A Shap Pocket share

A one-person business on Shap Pocket keeps its books on the owner's phone. **Accounts → Export →
Share your books with your accountant**, in Pocket, makes one file of the whole of the books: every
entry with its date, reference and description (which can name their customers and suppliers),
their accounts, and the business's details Shap needs to read them. It goes only where the owner
sends it, from the phone's share sheet. Each share is numbered and stamped, and Pocket counts it as
sent only when the share sheet says it went.

In the practice, a client added as **On Shap Pocket** gets **Bring in a share**: the first share
brings in the whole of the books; each one after it replaces the last entry by entry (what's the
same is left as it is), and Shap shows what's new, what changed and what's gone since the share
before, worked out from what Shap holds, whatever the phone says. An older share than the last one
brought in is refused, and so is one that would change anything in a closed period or a year whose
statements were approved (ask the client what changed there). The list shows the last share
brought in.

Their books here are a copy to read and compile: everyone opens them that way, the practice's
owner too. Adjustments the practice finds go to the owner, to make in Pocket and share again.

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
