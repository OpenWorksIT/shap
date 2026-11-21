# Shap Accountant

**Settings → What you use → Shap Accountant**, or the first-run questions (below, "Setting up a practice"). For an accounting practice: the practice's own Shap keeps
its clients' books too, each client in a database of its own on the practice's server, and shows
one list of the clients with what three of Shap's checks found in each and some of the returns
coming up. It's a part of Shap, not another app: every fix, check and SARS update reaches it in
the same release.

Shap is free software from OpenWorks IT, who are not accountants, auditors or tax practitioners.
Shap Accountant is a tool in a practitioner's hands: what its checks find and the dates it shows
are worked out from what's captured in each client's books, and from Shap's tables of SARS, CIPC
and Compensation Fund dates, which may be out of date. They're aids, not advice, and not every
check or return. The practitioner checks them. Shap files nothing with SARS, CIPC or the
Compensation Fund, and signs nothing.

Switching it on says back what the practice answers for: its clients' backups, who in the practice
opens them, their personal information (POPIA), and checking what Shap shows.

## A server of its own

**Shap Accountant needs Shap on a server of its own**: a VPS (a server rented online, set up as
docs/deployment.md has it) or a computer that only the practice uses, run by the practice or someone
it chooses. (deploy/test, which runs Shap on a PC through a tunnel, is for testing: it keeps no
backups.) Not a company added with `add-company.sh` to a Shap server that other businesses use:
such a company's database login can't make databases, and isn't meant to, so it can't keep clients'
books. The server's security, its backups, and who can reach the clients' books are the practice's
to look after (the Shap Accountant terms). A test server added with `--test-server`
(docs/TEST_SERVER.md) can try Shap Accountant, with made-up clients only (10 at most).

## Setting up a practice

In the first-run questions, **What do you do? → Accounting, bookkeeping or tax practice** asks
**Will you keep your clients' books in Shap too?** (An accounting practice can't be on turnover tax,
so choosing it switches that off and says why: docs/SARS.md.) Yes adds a step, **Your practice**:

- **The server.** Each client's books are a database of their own, so this Shap's database login
  must be allowed to make databases. The step looks (`GET /api/practice/server`, the owner's only)
  and says what it found: the default install's login is Postgres's superuser and may already; where
  other companies' books are on the server, it says Shap Accountant doesn't belong there; on a test
  server, or where nothing looks after the server, it gives whoever runs the server the one command
  (`alter role "<login>" createdb;`). Nothing on the server changes during the step.
- **Who works in your practice?** Just me (a solo practitioner), or me and my staff: how many, and
  whether to add their sign-ins now or later (Settings → People who sign in). Now: the profiles
  (**Bookkeeper**: opens the clients they're given, to write up their books; **Practice manager**:
  adds clients and chooses who opens each, and how; **Admin**: Shap's own, for the practice's own
  books), each changeable here, and more can be added; then each person's name, email, profile and
  starting password (Shap suggests one; the owner passes it on). They're made when the terms are
  accepted at the end, all at once or none (`POST /api/practice/team`), and only while nobody but
  the owner signs in: after that, one at a time in Settings. Which clients each person opens, and
  how, is chosen per client (Who opens which, below). Whichever way they're given a client, they can
  open it to compile, and whoever compiles signs the compilation report in their own name: who may
  sign one is the practice's to decide.
- The practice's own books start as a practice's usually are: invoices only, the time tracker, no
  counter sales; its line types and revenue accounts named Fees, Recharged costs and Other revenue,
  and the cost of what it recharges "Costs recharged to clients" (while unused: another kind of
  business chosen before then puts Shap's own names back); cost types for costs recharged to
  clients, software, CPD and office rent, with Parts hidden. Every later question can change that.
- **The terms**: Shap's, and the Shap Accountant terms, accepted for the practice by its owner (both
  ticks). Then, with Shap Accountant on, and only on a server whose Settings → Updates & backups
  shap-ctl looks after and that no other company shares, Shap asks it once
  (`POST /api/practice/server`, which leaves the `practice` request): shap-ctl reads the server's
  own Shap's login from the compose files (never from inside the app) and, if it may not make
  databases, gives it `CREATEDB` and nothing more. shap-ctl refuses while a company other than a test
  server is added to the server, and never touches an added company's login. Setup then opens
  Practice, which shows the owner the server's answer until it's ready (with **Ask the server** if
  it hasn't been asked), and adding a client says so too.

**A practice's own invoices**: what it bought itself and charges on (a courier it booked) is a
recharged cost, its own supply (with VAT if it's a vendor) and its revenue. An amount paid in the
client's name as its agent and recovered at cost (a CIPC or SARS fee) generally is neither: it isn't
the practice's revenue (IFRS for SMEs 23.4 leaves amounts collected for others out) or its supply
(VAT Act s54(2)), and the slip's VAT isn't its to claim. Every line on a Shap invoice is revenue, so
Shap has no item for it: recover it outside Shap's invoices, or with a journal through a balance
sheet account, as the practice's own policy has it.

## The Shap Accountant terms

A practice uses Shap Accountant on the [Shap Accountant terms of
use](https://www.openworks.co.za/shap/accountant-terms/): Shap's terms (Part A), with what a
practice takes on (Part B): its work for its clients is its own, Shap's checks, returns and tax
figures are aids and estimates, its clients' books and personal information (POPIA) are in its
care, and it indemnifies OpenWorks against claims by its clients or anyone else over that work, its
use of Shap on their books, the personal information it keeps there, or a breach of the terms
(clause 13). Only practices accept them, so Shap's own terms, and everyone else's acceptance of
them, don't change.

- **The practice's owner accepts them for the practice** (`POST /api/practice/terms`, the owner's
  only, in the practice's own books): before Shap Accountant is switched on (Settings → What you
  use shows them, with what the practice answers for), and again whenever
  `ACCOUNTANT_TERMS_VERSION` changes (Practice shows them). Until then the practice's routes
  refuse, and no client's books open: someone already in one is taken back to the practice.
  Nothing in the clients' books changes meanwhile, except monthly invoices set up there, which are
  still made on their day (held back, a later catch-up could land in a month closed since). The
  owner can still download each client's backups (`GET /api/practice/records`, and the backup
  routes check only that Shap Accountant is on), so a practice can always hand a client its books.
  The version and when are kept in the practice's settings, and the audit log has
  `accept_accountant_terms`. That acceptance covers every client's books the practice keeps.
- **In each client's books**, the practice records its acceptance for its use of Shap on those
  books (`PRACTICE_TERMS_TICK`, under the owner's acceptance for the practice: at setup, on the
  first Pocket share, and when Shap's terms change): those books' audit log records both versions.
- When Shap's terms change, Part A changes with them, and both versions go up
  (`ACCOUNTANT_TERMS_VERSION` is never older than `TERMS_VERSION`).

## The clients

**Practice** (in the menu) lists the clients. Each has its own books:

| Kind | Where the books are | In Shap |
|---|---|---|
| Kept by the practice | A database of its own on the practice's server | Now (1.27) |
| Brought in from another package | The same, from Xero's, QuickBooks' or Sage's trial balance and general ledger exports | Now (1.28) |
| A Shap Pocket share | A read-only copy of the owner's phone books, stamped, the next share marking what changed | Now (1.29) |
| Linked from the client's own Shap | On the client's own server; Open signs the practice's person in to it, in a new tab | Now (1.30) |

Each client's engagement letters and working papers (1.31) are the practice's own: below, "Engagement letters and working papers".

**Add client** (for whoever may add clients) makes a new set of books named for the business.
**Open their books** puts this browser into them, with Shap's screens; the first time, Shap asks
its first questions about the business (the Welcome), as for any new Shap, but not the two about
sharing with OpenWorks, and the Shap Accountant terms are accepted for the practice's use of Shap on these books.
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
Share your books with your accountant**, in Pocket, makes one file of the whole of the books:
Pocket's records themselves, whatever their dates (the invoices, costs, assets, pay runs, journals,
logbook trips and the rest, as captured), with their references, descriptions and notes, which can
name the business's customers, suppliers, workers, employees, partners and shareholders and what
they were paid (and, for payroll, the employees' age bands and medical aid members); each trip's
date, kilometres and reason, and the logbook's odometer readings; the accounts; and the business's
details: its name, its registration, VAT, PAYE, UIF and income tax numbers (a sole proprietor's
income tax number is their own), its year end and invoice terms, and what the owner filled in for
its financial statements (directors, addresses, secretary, bankers). Left out: who signs in, photos
of slips, employees' ID, tax and bank numbers, the contact details, addresses and notes of
customers, workers and jobs, the address, phone, email and bank details in the business's settings
and on its trading names, where trips went from and to, the logbook's vehicle, and the tax
estimates saved in Pocket (a sole proprietor's carry their income from elsewhere)
(`SHARE_TABLES` in packages/shared pocket-share.ts; the panel's words, `SHARE_WHAT_GOES`, are tested
against a file). It goes only where the owner sends or saves it, from Pocket's share sheet (on a
computer, a download). Each share is numbered, stamped with the day it was made and with these
books' own id, and says what changed since the last one shared. Pocket counts it as shared once
the owner picks where it goes on the share sheet (on a computer, once it's saved), whether or not
it reaches you: Shap works out what changed from what it holds, so a share that never arrived does
no harm.

In the practice, a client added as **On Shap Pocket** gets **Bring in a share**, for the practice's
owner or whoever is given the client's books to write up. The first share records the practice's
acceptance of the Shap Accountant terms for these books (and the first after Shap's terms change). Each share
replaces the copy's records with the phone's: Pocket's tables are Shap's (the same accounting
code), so the copy works out its VAT201s, payroll, statements and checks from what Pocket does.
Shap checks it reads the records into the same entries the phone did, every one by its hash, and
brings nothing in if it doesn't (one Shap or the other may need updating). Then it shows what's
new, what changed (an entry moved to another day counts once) and what's gone since the share
before, worked out from what it holds.

What Shap refuses: a share of other books (each is tied to the first share's books id); the same
share again, or an older one (a lower number made later is taken to mean the books were restored
or begun again on the phone, and marked so); a share with an account Pocket keeps itself that this
Shap doesn't know (one of the two may need updating); and, once the practice has compiled or
approved a year's statements here, a share that moves that year's entries (the refusal lists
them), changes what its statements show (an account's kind, name or the line it's shown on, say), or
changes the kind of business, the year end or VAT registration they were drawn up on (renamed
customers or changed memos come in). One share comes in at a time. Shap's own accounts in the copy
keep their ids whatever a share has. Refunds and stock records, which are otherwise never changed
or deleted, are replaced with the phone's in the share's own transaction only.

The copy is the practice's to compile in: whoever opens it compiles the statements there and
records the approval of whoever signs them for the business (its directors, members, partners or
owner; recording it, and nothing else: the year ends and closed months are the owner's, from
Pocket), and the copy's own books aren't written in. Adjustments the practice finds go to
the owner, to make in Pocket and share again. The figures are the client's, as the share has them:
Shap doesn't check them against the client's records (`POCKET_SHARE_NOTE`).

## A client on its own Shap

A business that runs its own Shap links its accountant itself: in its Shap, **Settings → People who
sign in → Your accountant**, its owner chooses what the practice may do there and makes a link (it
takes their password). The two ways are the practice's own:

| What the client lets the practice do | Who they are in the client's Shap |
|---|---|
| Read the books and compile the statements | Its accountant (read only, but for the statements' details and the small business corporation answer, as for any accountant); they can download and print what's in the books |
| Write up the books, and compile the statements | Staff, with every task but closing and reopening months (`LINKED_BOOKS_TASKS`), so they also issue and email invoices and quotes in the business's name; or its accountant, to compile |

What stays the client owner's either way (`LINK_STAYS_OWNERS`): their settings (VAT, PAYE and
turnover tax among them) and the chart of accounts, the people who sign in, closing and reopening
months and VAT periods, the year end, tax estimates and provisional tax paid, dividends and profit
shares, approving the statements, and backups. (A dividend or provisional tax journalled by hand
isn't recorded as one: a dividend journalled by hand is still taken as paid on its day for the
returns on the practice's list.) Compiling in Shap needs the client's financial statements switched
on.

The link is the client's Shap's address and a code (`https://their-shap/link#…`). It works once,
for a week, and only its hash is kept: whoever uses it first is linked, so the owner gives it only
to their accountant and checks the practice's name once linked. In the practice, someone who adds
clients chooses **On their own Shap** and pastes it in: Shap Accountant shows the code to the
client's Shap once, and gets a credential for this link (sealed with the server's secret here;
only its hash there). From then on the two servers talk only for this:

- **Open their books** (as given in the practice, never more than the client allows): the
  practice's server asks the client's for a sign-in for that person, and their browser opens it
  in a new tab. It works once, within a minute; they're then in for `LINK_SESSION_HOURS` (8) hours
  at most, however busy (use doesn't make it longer). In the client's Shap they're someone of their
  own (their name and the practice's), never signing in with a password, and kept out of the
  owner's people list; what they do is in the client's audit log by name. Where the client's Shap
  requires two-factor sign-in of everyone, they must have it on at their practice (their practice's
  Shap says whether they do). A
  browser where someone else is signed in to the client's Shap isn't signed out by it: they sign
  out there first. The bar at the top says whose Shap it is, and from which practice. They sign
  out there when done.
- **Run the checks** (and once when linking): the client's Shap runs its own checks and sends what
  they found (`healthForLink`: the books audit's first findings, cut to length, which can name its
  customers and suppliers; the statements' standing; how far the books are closed; and what the
  returns are worked out from). The practice's list shows them as the client's Shap sent them;
  one it can't read is said, and what was shown before stays, marked as from before.
- **Who opens it** changed or taken away, or the person's own access in the practice (their
  sign-in switched off, their tasks changed): the practice's server asks the client's Shap to take
  them out, at once. If it doesn't answer, the practice is told who may still be in, until their
  sign-in there ends.
- **Unlink**, from either side: the credential goes, and the practice's people are taken out of
  the client's books. To link again, the client makes a new link (**Link again** keeps the
  practice's choices of who opens it). What the practice's server was sent stays there, with the
  client in its list (unlinked).

What goes between the servers, and nothing else: to the client's, the code and the practice's name
once, then who opens the books (an id, their name and whether they use two-factor) and at what
level; back, the client's name, what it allows, sign-ins and the checks' findings. Nothing goes to
OpenWorks IT because of it. What the client's Shap says in words when it refuses isn't shown in the
practice: only what its code means, in the practice's own words. A practice's server reaches only
public https addresses (a name that resolves to a private one is refused when connecting, no
redirects followed, ten seconds in all, a small answer: `lib/link-call.ts`); on a practice's own
network, `LINK_PRIVATE=true` lets it reach private addresses, over http too, but never link-local
ones (a cloud server's metadata). Only the link's own routes (`LINK_PATHS`) are answered without a
session there, each reading a small body. Both Shaps need 1.30 or later.

## Engagement letters and working papers

**Working papers and letters**, on each client's card in Practice, is the practice's own record of its
work for that client: kept in the practice's database (`modules/working-papers.ts`), never in the
client's books, and reached only from the practice (not from inside a client's books). Anyone given
the client sees it; who may do what is below. Nothing here stops anyone compiling or filing: what's
missing is shown on the practice's list (each client's latest ended year), in the year's papers, and,
in a client's books kept here or brought in from Shap Pocket, before **Compile and sign**. A check,
never a lock (the practitioner's call). A wipe of the practice's own books keeps them, as it keeps
its clients.

### Engagement letters

**New letter** (for whoever manages the practice's clients) drafts one from the client's details in
Shap (`lib/engagement.ts`): what the practice will do (write up the books, the payroll, VAT, income
tax, compiling the annual financial statements, a close corporation's accounting officer, anything
else), from which year end, the fees as the practice words them, and its professional body. A
client in Shap Pocket writes up their own books, so that isn't offered for them; a company's
accounting officer isn't either. It's a starting point (`LETTER_NOTE`): not complete, and not
checked against the law or the practice's professional body's rules for the client. The practice
reads all of it, checks it against its body's guidance (and an attorney, for anything legal), and
changes any of it while it's a draft: its words, and the parties it names (the practice's legal
name, registration number, trading name and address, from Settings; the client's legal name, from
its books).

For compiling the statements it's drafted to cover what ISRS 4410 (Revised) para 24 asks the agreed
terms to say; whether it does for an engagement is the practitioner's to check: their intended use
and distribution (a sole proprietor's, a partnership's or a trust's are special purpose, for them
and SARS, and the report says they may not be suitable for other purposes); the framework (the IFRS
for SMEs Accounting Standard and the business's Act, or the basis note 1 describes); the
engagement's objective and scope (not an assurance engagement, and an audit or review, where the
business needs one, is a separate engagement); the practitioner's responsibilities (its body's
ethical code); management's (who approves the statements, for each kind of business: a close
corporation's members holding at least 51 per cent of the members' interest, Close Corporations
Act s58(3); and their acknowledgement of the final version, para 37); and the report's addressee and
expected form (the practitioner's compilation report). Its tax paragraphs follow how the client is
taxed (an approved public benefit organisation's IT12EI and no provisional tax; turnover tax's TT02
and TT03; each partner's own returns; a trust's IT3(t)), with a part on dealing with SARS whenever a
tax service is ticked (eFiling authority; SARS's letters; penalties; and, only when the practice
ticks that it's so, that those who prepare returns are registered tax practitioners or supervised
by one, TAA s240: Shap doesn't say it for the practice). A close corporation's accounting officer's
duties are drafted from sections 59 to 62.
It also says where the client's books are (kept here, Shap Pocket shares, or their own Shap), the
records the law asks each side to keep (TAA s29 and s32; a company's Companies Act s24), and the
personal information the practice processes, kept confidential and secure as POPIA asks (it
promises no deletion: Shap keeps an archived client's books and papers).

Then: **Draft PDF** (to read: headed "Draft, to read: not for sending", with `LETTER_NOTE` on it),
**Mark as sent** (it asks first: its words and parties are kept as they are from then, by the
database itself, and a new letter changes the terms), then its **PDF** (with lines to sign, and
nothing of OpenWorks on it) to send: Shap sends nothing to the client, the practice does.
**Record their acceptance** (who, in what capacity, and when, not before the day it was sent; with
the signed copy uploaded, a photo made smaller first, kept with the letter; or recorded without
one). **End** records the last year it covered (or none): it's kept, as it was, and still covers
those years; ending it in Shap doesn't end the engagement with the client, which the letter says is
done in writing. Downloading a letter or its signed copy is in the practice's audit log.

A recurring engagement (para 26): an accepted letter runs on to every later year, and for each the
practice records that its terms were looked at again and still fit (**Terms still fit for the year
to …**), or makes a new letter, which then governs the years from its first (that year needs no
second look). Until then, the list says so. A letter that isn't for compiling covers its years
without a warning on the list ("not for compiling"); the compile form says it, if the practice does
compile them.

### Working papers

For each of the client's years that has ended: from the books' first (on their own Shap, the last
four), and any year the books have closed or have statements for, or that has papers already. Those
stay open when the client's year-end month changes, each worked out over its own twelve months.

- **Review notes**: on the year, or on one of its accounts; answered by anyone given the client;
  cleared (or opened again) by whoever raised them, or an owner. A year takes 200 notes at most, a
  note 30 replies, and its notes and replies together 200,000 characters (its file is a PDF made on
  the server).
- **The trial balance at the year end** (books on the practice's server: kept, brought in, Shap
  Pocket), with its debit and credit totals, each account ticked as **prepared** (whoever writes up
  the books) and **reviewed** (anyone given the client), with who and when. A tick is the account's
  own (a new code doesn't move it) and keeps the balance it was given at: if the books move, it says
  the balance has changed since. A review by whoever prepared it is said, not refused (a sole
  practitioner reviews their own). A client on its own Shap keeps its trial balance there: nothing
  new comes over the link, so its papers have notes and sign-offs, not ticks.
- **Sign-offs** for the year: **prepared** (whoever writes up the books), **reviewed** (anyone given
  the client) and **engagement partner** (an owner: the practice's partners are its owners in Shap).
  Reviewed and the partner's wait for every review note to be cleared; a note raised or opened again
  takes them back (it asks first, and each is in the audit log). A partner's sign-off without a
  review is said so. Each keeps the trial balance as it was (its rows, by account, and their
  fingerprint), and says when the books have changed since: in the papers, and on the compile form.
- **Download the year's file (PDF)**: the sign-offs, the letter's standing, the statements' compile
  and approval dates, every review note with its replies, and the trial balance's ticks and totals.
  It's an aid towards the practice's record of the engagement (para 38), not the whole of it: keep a
  copy of the final set and the compilation report with it (para 38(c)), since the client's books
  go back to them when the engagement ends. For a client on its own Shap, download the signed set
  there: it isn't reachable once they unlink you.

Shap records what the practice's people tick, note and sign (each in the practice's audit log,
without an account or a balance: people not given the client read that log); it doesn't check the
work behind them (`FILE_NOTE`).

## Who opens which

The practice's owner opens every client, to write up or to compile. Anyone else needs **Open the
clients they're given** ticked (Settings → People who sign in) and the client given to them under
**Who opens it**, either:

- **Writes up the books, as their owner in Shap**: they can do everything the client's owner could,
  reopening closed periods included, and they record the client's approval of the financial
  statements (below). They can also open the books to compile. In a Shap Pocket client's copy, they
  bring in the shares, compile, and record the approval: the books themselves change only in Shap
  Pocket (above). On a client's own Shap, they're staff there, doing what the client lets the
  practice do (above): never more, and never as its owner.
- **Reads them and compiles the statements, as their accountant in Shap (read only)**: the
  financial statements, docs/STATEMENTS.md.

In a client's books each person from the practice is there by name, so the client's own audit log
says who did what; they're never taken for the client's own directors. Taken off a client, or
given it another way, they're out of its books at once (open it again, as given now).

**Add clients and choose who opens each** lets someone other than the owner do the adding and
the giving, themselves included, and see every client.

## The financial statements in a client's books

The practice compiles them in Shap, as itself (**Open to compile**): a compiler's report isn't
uploaded in a client's books. Approving them is the client's own decision, taken by those the law
and its own rules give it to (a company's board, with a director it authorises signing; a close
corporation's members holding at least 51 per cent of the members' interest; a trust's trustees; the
partners; the owner), and the practice records it, uploading the page signed and the name of one of
those named in the statements' details (**Record the directors' approval**). Shap checks only that
the name is one of those, not the signature, the decision or anyone's authority to give it. Shap won't compile until
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
IT3(t) and EMP501 interim dates, and (since 1.33) CIPC's annual return for a company or close
corporation whose date of incorporation is in Settings → Company, and the Compensation Fund's
return of earnings for an employer that says it's registered with the Fund, once the Fund has
announced the season (only announced seasons are shown). A client on its own Shap sends these from
1.33, for a link its owner made from 1.33 on (the owner is told so before linking; an older link
isn't sent them). Returns due in the last few weeks show as "was due": Shap can't tell whether they were
filed.

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
  createdb;` for Shap Accountant: shap-ctl does that when setup or Practice asks (above, "Setting up
  a practice"); `deploy/vps/ctl/shap-ctl.sh`'s `practice` step, tested in
  `apps/server/test/ctl-script.test.ts`. A login that may make databases chooses their names, so
  shap-ctl's backups take only names Shap makes (`shap`, `shap_<company>`, `<db>__c_<hex>`), one a
  line, and a name never steers where they're written. Client databases made by a superuser before
  a move to `shap_app` are handed over with `alter database "<name>" owner to shap_app;`.
- **A client's database is opened only if this Shap's own login owns it** (checked from the
  practice's own database, before it's migrated, opened, checked or used for monthly invoices). One
  another login made under a client's name (one that may make databases, after the client's was
  dropped or while it's restored) could be set up to run its own code in this Shap's sessions, so it
  isn't used. Hand one over only if you know where it came from (made by this server's own Postgres
  login before a move to a least-privilege login, or restored from this client's backup); if not,
  leave it and find out who made it. Staff who open it are told whose it is and that it isn't
  opened, and to ask the owner; the owner is also told this Shap's login and the command (as the
  server panel is the owner's). A login name Shap wouldn't make is shown in quotes, in plain
  ASCII, anything else escaped.
