# Changelog

What changed in each version of Shap, newest first. Settings → Updates & backups shows the
entries newer than the version you're running before you update.

## 1.33.0 (21 November 2026)

- **A cash-flow forecast.** Accounts → Cash-flow forecast: the next 13 weeks of money in and out,
  week by week, from what's in the books. It starts from the cash as your statements count it
  (what the cards owe is shown beside it), with invoices on their due dates (overdue ones this
  week, as if paid now; those more than 90 days overdue shown apart, not counted), supplier bills
  on theirs, what's already in the books for a day to come (a pay run paid on its pay day, a payment
  dated ahead: not counted again), salaries and the EMP201 for everyone in the last pay run at
  their usual pay while a run would still take them (not someone who has left; to someone who
  doesn't see payroll, as if no one leaves who hasn't yet), on the usual day
  (the EMP201 by the month paid), dividends tax on its date, wages and dividends owed now (those
  owed in the books by a journal or balances brought in too; one paid by a journal not counted
  again), PAYE, UIF and SDL owed in the books beyond your pay runs (brought in when moving in, say)
  this week (and an EMP201 or DTR01 the books show paid by a journal not counted again), day wages at the last eight weeks'
  average, the VAT as invoiced on each VAT201 (an older one this week; a trial balance brought in
  counts as owed for periods gone by, and a refund SARS owes isn't netted off another period's VAT), and the costs you usually
  pay each month (as last paid: not those paid personally or on a card; one that comes as a
  supplier bill on the bill's terms; not a month already captured ahead). Tap a week for what's in it. Sales not made or invoiced yet
  aren't in it, nor are provisional or turnover tax, drawings, or card and loan repayments: an
  estimate to plan with, not advice.
- **Budgets.** Accounts → Budgets: each income and cost account's twelve months for a financial
  year, against what the books show for the months that have ended, and the difference (the
  totals over the accounts with a budget). Type in the months, spread a year's total evenly, copy
  last year's, or start every account without a budget from last year's figures (the twelve months
  before), up or down by a percentage to one decimal place. The owner sets the budget;
  anyone who reads the reports sees it. A budget set before the year end changed still opens. A
  plan, not the books: nothing is posted from it.
- **More bank statement formats, and rules.** Bank statements come in as OFX (or QFX, as most banks'
  internet banking exports) and QIF as well as CSV, one account a file (a file whose amounts are
  all positive is read by its transaction types; a QIF's opening balance is left out, as a CSV's
  balance lines are; the preview says how many lines were left out, and what they can be). *Always this* on a line
  saves a rule: lines that say what you choose get the same cost type or income account, and
  supplier, every time they come in (500 rules at most). Bank → Rules lists them, and says why one
  isn't applied (its cost type or account switched off, its cost type now stock, or its account no
  longer income). Nothing posts
  until you tick it, as before. Amounts written -.50 or 1.234,56 are read right (before, -.50 was
  left out and 1.234,56 read as R1.23: if your bank writes amounts this way, check statements you
  brought in before), and a very long description no longer stops an import.
- **Moving in.** A trial balance's PAYE, UIF and SDL owed are suggested on their own SARS accounts
  (as books from another package are), not on wages owed to workers; and VAT, PAYE or income tax
  "payable" (or VAT "receivable") is suggested as SARS's, not as creditors (or debtors). You still
  confirm each account before it goes in.
- **Barcodes with the phone's camera.** At the counter and on an item's code, the camera button
  scans a barcode (Chrome on Android: the browser reads it on the phone, and Shap sends the picture
  nowhere). A barcode scanner, or typing the code and Enter, works everywhere: an exact code adds
  the item.
- **Home.** The money in the bank and till as the statements count cash (and what the cards owe),
  how many days clients take to pay against your invoices, how many you take to pay supplier bills
  (with bills on), and the gross margin month by month, as the income statement's gross profit.
  Home's first figure is now revenue (it was all income, interest included), gross profit is
  revenue less cost of sales, net profit says the running costs, finance costs, income tax and
  other income between them (and, when none is captured, says it's before a company's income tax,
  or that an owner's or partners' tax is their own, not the business's; on turnover tax, that a company's is
  in it only as captured; for an approved PBO, before any income tax on trading beyond its exemption), and the year
  to date runs to today. What's in a bank or cash account you pay from that isn't on the
  statements' cash line is said under the money in the bank (and on the forecast), not counted:
  Shap doesn't move its line, and the books audit points it out, with what usually decides it (for
  a deposit, and for an overdraft), for you and your accountant to judge. Moving a payment account (or a cost
  type) that's been used onto another account is refused when its history would move on or off the cash
  line with it (change the line of the account that's wrong, with your accountant), or would move
  anything in a closed period, from a company file brought in too, and a change of an account's line, or of the account behind a payment account or cost type, is in the audit log,
  with both accounts' names and lines and the amounts that moved, by financial year. A company file
  that gives an account no line leaves its line as it is; one that gives it a line that doesn't fit
  its type, or another type, or turnover tax without a February year end, is refused, as Settings
  refuses them; and it turns turnover tax (and PBO approval) off for a business that can't have it.
- **VAT201.** When journals typed in (a cash sale journalled, a correction) moved the VAT account in
  a period, other than as payments to or refunds from SARS (VAT against the bank, cash, a card, your
  own money or SARS's other taxes), the VAT201 screen says what they added to the VAT owed and what
  they took off it, and so does the books audit: the boxes are worked out from invoices, costs and
  assets, so they leave those out, and where they go on the return is yours or your accountant's to
  decide. Import VAT journalled against the bank looks like a payment, so it isn't counted there
  either: the screen says so under the boxes.
- **Journals.** A journal takes up to 1 000 lines: split a longer one into journals that each
  balance. (One very long journal could make the VAT201 screen and the books audit take minutes:
  they now read each journal once.) A Shap Pocket share holding a longer one is turned away, saying
  so.
- **Payroll.** A pay date before the month before its run's month, or more than six months after
  it, is refused as a likely slip of the year or month (it could be taxed on the wrong year's tables or go on the wrong EMP201). A
  run paid more than a month after its month, or in another tax year (a February run paid in
  March), says that which EMP201 it goes on, and which tax year's tables, are your accountant's to
  check.
- **CIPC and the Compensation Fund.** The date of incorporation (Settings → Company, and in the
  first-run questions, both optional) gives a company's or close corporation's CIPC annual return
  on Home and the practice's list, from five weeks before it's due to a month after. An employer
  (casual workers too) is asked whether it's registered with the Compensation Fund (COIDA): if it
  is, the return of earnings shows for a season in Shap's tables (for March 2025 to February 2026,
  1 April to 30 June 2026), and from April to July Home says when the next season's dates aren't in
  this version of Shap. Even with no reminder, a return may be due. Shap files nothing with CIPC or
  the Fund. A client on its own Shap sends these to its practice from 1.33, for a link made from
  1.33 on (the owner is told so before linking).
- docs/GOALPOSTS.md: what's being worked on, how hard it looks and why (also on the website).

## 1.32.0 (18 November 2026)

- **Shap Accountant from the first-run questions.** Choose *Accounting, bookkeeping or tax practice*
  and say you'll keep your clients' books in Shap too: a step for your practice follows, the Shap
  Accountant terms come with Shap's at the end, and then Practice opens. The practice's own books
  start as a practice's usually are (invoices only, the time tracker, no counter sales; fees,
  recharged costs and other revenue; cost types for costs recharged to clients, software, CPD and
  office rent), and any later question can change that. An amount you pay in a client's name as
  their agent generally isn't your revenue or your supply, so Shap has no invoice item for it
  (docs/ACCOUNTANT.md; check with your accountant). An accounting practice can't be on turnover
  tax, so choosing it switches that off and says why.
- **The server.** Each client's books are a database of their own, so the practice step checks that
  this Shap's database login may make databases, and says what it found. Once you've accepted the
  terms, on a server whose Settings → Updates & backups is looked after by shap-ctl and that no other
  company shares, Shap asks it once (shap-ctl's new `practice` step: this Shap's own login only,
  `CREATEDB` and nothing more). Anywhere else it says what whoever runs the server does. Practice
  shows the owner the server's answer until it can make clients' databases, with *Ask the server*.
- **Your practice's people, in setup.** Just you, or you and your staff: how many, and now or later.
  Now: the profiles (Bookkeeper, Practice manager and Admin, each changeable, and your own) and each
  person's name, email, profile and starting password (Shap suggests one), made all at once when you
  accept the terms. Later: Settings → People who sign in, as before. Who opens it says that whichever
  way someone is given a client, they can open it to compile, and that whoever compiles signs the
  compilation report in their own name.
- **A server of its own.** Shap Accountant needs Shap on a server of its own: a VPS or a computer
  only your practice uses. A company added to someone else's Shap server can't keep clients' books
  (add-company.sh says so), and the practice step and Practice say when other companies' books are
  on the server. A test server can try Shap Accountant with up to 10 made-up clients:
  `--test-server` lets its login make databases (docs/TEST_SERVER.md has the command for one added
  before this).
- **Backups**: shap-ctl now backs up only databases with the names Shap gives them.
- **Time not invoiced by the year end**: the financial statements' checks list time tracked in the
  year (or before it and invoiced only after the year end) that wasn't on an invoice issued by the
  year end, directly or through a quote (with its value at your hourly rates), to consider accruing
  the revenue; and the revenue policy no longer says all work is invoiced as it's done when it isn't.
- The VAT option *Exempt or not a supply* says a fee paid in a client's name as their agent and
  recovered at cost is generally neither your supply nor your revenue, so it stays off your Shap
  invoices (check with your accountant). Turnover tax's caution says a business with more than
  20% of its receipts from professional services (for a company, with its investment income) can't
  be on it.
- A demo company's database someone else made under its name is never used (the demo is off, and the
  log says why).

## 1.31.0 (17 November 2026)

- **Shap Accountant: engagement letters** (Practice → a client → Working papers and letters). Draft
  one from the client's details, choosing what your practice will do for them. For compiling the
  statements it's drafted to cover what ISRS 4410 (Revised) para 24 asks the agreed terms to say;
  whether it does for an engagement is the practitioner's to check. Its tax paragraphs follow how
  the client is taxed (an approved public benefit organisation's IT12EI, turnover tax's TT02 and
  TT03, a partnership's partners), and a close corporation's accounting officer's duties are drafted
  from sections 59 to 62 of its Act. It says your people who prepare returns are registered tax
  practitioners only if you tick that they are. A starting point, not complete and not checked against the law or your professional
  body's rules: the letter, and the engagement, are your practice's own. Read the draft and change
  any of it (its words, and the parties it names); mark it as sent, which keeps its words and
  parties as they are; then download its PDF and send it yourself (Shap doesn't send it). Record
  their acceptance (with the signed copy, or without), each later year record that its terms still
  fit, and when a letter ends, the last year it covers.
- **Shap Accountant: working papers** for each of a client's ended years: review notes, raised,
  answered and cleared; the trial balance at the year end, with its debit and credit totals, each
  account ticked as prepared and reviewed (clients on their own Shap keep theirs there: notes and
  sign-offs only); and the year signed off as prepared, reviewed and by the engagement partner. A
  note raised or opened again takes back the review and the partner's sign-off. Each says when the
  books have changed since, and a year stays open after the client's year-end month changes. The
  year's file downloads as a PDF: an aid towards the practice's record of the engagement, kept with
  a copy of the final statements and report. The practice's list, and the compile form in a
  client's books, say what isn't recorded yet: checks, never locks.
- The compiler's report on the financial statements is titled **Practitioner's compilation report**,
  as ISRS 4410 (Revised)'s example reports title it (it said "Independent compiler's report"), and
  the screens call it the compilation report. For a sole proprietor, a partnership or a trust it
  says the statements are prepared for them and SARS, and may not be suitable for other purposes;
  addressed to a company's shareholders or a co-op's members, it says the directors provided the
  information and are responsible for it.
- The Shap Accountant terms of use (version 2026-11-17.3) name the drafted engagement letters and
  the working papers among Shap's aids, and correct who approves a close corporation's statements
  (members holding at least 51 per cent of the members' interest). Practices accept them again;
  Shap's own terms don't change.
- Updating a practice's server (`migrate-cli`) brings its clients' books up to date too, as starting
  the server does.

## 1.30.0 (17 November 2026)

- **Link your accountant** (Settings → People who sign in → Your accountant). If your accountant's
  practice uses Shap Accountant, link it to your Shap: choose whether they read your books and
  compile the statements, or write them up too, and give them the link it makes (it works once, for
  a week; give it to them as you would a password). They open your books from their Shap, each time
  with a sign-in that works once, and are then in for 8 hours at most; who they are is in your
  audit log, and they're never in your people list. Where your Shap requires two-factor sign-in,
  they must have it on at their practice. The panel says what they can do, what stays yours, and what goes to
  their Shap. Unlink whenever you like.
- **Shap Accountant: clients on their own Shap** (docs/ACCOUNTANT.md, "A client on its own Shap").
  Paste a client's link under Practice (On their own Shap): their books stay on their Shap, and
  your people open them there, in a new tab, as given here and never more than the client allows,
  as staff or their accountant there (never as their owner). Run the checks shows what their Shap's
  checks find, as it sent them. When someone's access changes here (who opens it, their tasks, their
  sign-in switched off), or either side unlinks, their Shap is asked to take them out at once, and
  you're told if it didn't answer. A practice's Shap reaches only public https addresses for this.
- The Shap Accountant terms of use (version 2026-11-17.2) cover a client's books on its own Shap;
  a practice's owner accepts them again on the Practice page.
- A compiled set of financial statements is reopened before it's compiled again, so the signed set
  is kept. A bank statement line matched to a bill's payment shows as matched (it showed as open),
  and matches taken from the suggestions are in the audit log. A dividend journalled by hand puts
  its dividends tax return on the practice's list.

## 1.29.1 (17 November 2026)

- **The Shap Accountant terms of use** ([openworks.co.za/shap/accountant-terms](https://www.openworks.co.za/shap/accountant-terms/)).
  A practice now uses Shap Accountant on terms of its own: Shap's terms, with what a practice takes
  on when it keeps its clients' books in Shap. Its work for its clients is its own, Shap's checks,
  returns and tax figures are aids and estimates, its clients' books and personal information are
  in its care, and it indemnifies OpenWorks against claims by its clients or anyone else over that
  work, its use of Shap on their books, the personal information it keeps there, or a breach of the
  terms. The practice's owner accepts them before Shap Accountant is switched on, and a practice
  already using it is asked once, on the Practice page, before any client's books open again.
  Nothing in the clients' books changes meanwhile, except monthly invoices set up there, which are
  still made on their day, and the owner can still download each client's backups. Shap's own terms
  haven't changed: nobody else is asked to accept anything again.

## 1.29.0 (17 November 2026)

- **Shap Pocket clients** (Shap Accountant; docs/ACCOUNTANT.md, "A Shap Pocket share"). A
  one-person business on Shap Pocket shares its books from their phone; in the practice, a client
  added as **On Shap Pocket** gets **Bring in a share**. Each share carries the whole of Pocket's
  records (employees' ID, tax and bank numbers, the contact details of customers, workers and jobs,
  the business's own contact and bank details, where trips went, the logbook's vehicle, the tax
  estimates saved in Pocket and photos of slips stay there), so the practice's copy works out the VAT201s, payroll, statements and checks from what
  Pocket does, and Shap checks it reads them into the same entries the phone did. Each share says
  what's new, changed and gone since the one before. A share of other books, an older one, or one
  that would move a year the practice compiled or approved here (its entries, or what its
  statements show) is refused, saying what it would move. The practice compiles the statements in
  the copy and records the approval of whoever signs them for the business; the books themselves change only in Shap Pocket.
  Shap reads a share as it finds it and doesn't check it against the client's records: the figures
  stay theirs.
- A cost put right as an asset by journal shows as an asset bought in the statement of cash flows,
  not as negative depreciation; books that begin with the opening balances moved in say the years
  shown start from nil before them.

## 1.28.0 (17 November 2026)

- **Books from another package** (Shap Accountant; docs/ACCOUNTANT.md). For a client who keeps their
  books in Xero, QuickBooks or Sage (Accounting or Pastel): in their books, **Accounts → From
  another package** brings in the trial balance at a date and the general ledger for a period, from
  the package's own Excel or CSV exports, to check and compile here while the client stays on
  their package. Shap reads the files as it finds them and doesn't check them against the package:
  compare the trial balance after bringing them in. Each of their accounts goes to one of these books' (remembered for next time) or,
  for the owner, a new one on the statement line their package's type gives. **Check what it would
  do** shows each journal and what each trial balance would move before anything comes in. A
  ledger's journals come in as its transactions; a trial balance brings the books to its figures,
  with the practice's own entries left as they are. Nothing goes into a closed period, an agreed year or
  approved statements; a trial balance brought in earlier comes in again with what's brought in under it, or that's refused; each file's
  fingerprint (SHA-256) is kept, and the activity log has what came in, what it replaced and what
  was taken out. The statements need the year end's trial balance and the two before it: brought
  in alone, the statements' checks say the years start from nil before it. A VAT201 or payroll
  worked out in the other package isn't Shap's to work out or check, and the screens, the tax pack
  and the books audit say so; the tax estimates project from the last day brought in. Shap's
  figures are estimates only.
- Depreciation posted by journal (by hand, or in books brought in) is added back in the statement of
  cash flows, not shown as an asset sold (IFRS for SMEs 7.8).
- Amounts such as "R (1 234.56)" and "1 234.56 Cr" in a moved-in or brought-in file are read as
  credits.
- A spreadsheet or CSV made to hold the server up (a cell far off, a zip that says it's smaller than
  it is, millions of columns) is refused quickly, and the server goes on answering everyone else.
- The feedback trail names a field or button among people's or accounts' names only by where it was.

## 1.27.0 (17 November 2026)

- **Shap Accountant, for a practice** (Settings → Features; docs/ACCOUNTANT.md). Off unless switched
  on. The practice's own Shap keeps its clients' books too, each in a database of its own on the
  practice's server: a query in one client's books can't reach another's, and Shap checks who may
  open which on every request. **Practice** lists the clients with what three of Shap's checks
  found (the books audit, the statements for the last year that has ended, how far the books are
  closed) and some of the returns coming up (VAT201, EMP201, provisional tax, turnover tax, ITR14
  and the filing season's dates), from each client's settings and Shap's SARS tables: aids to
  check, not advice. **Open their books** works in them with Shap's screens (not the server's own:
  updates and backups, people, feedback), the bar saying whose they are; nothing is emailed from
  them, and nothing about them goes to OpenWorks. The owner opens every client; anyone else, the
  clients they're given, to write up (as their owner in Shap) or to read and compile. The practice
  compiles a client's statements in Shap and records the directors' approval with the page they
  signed. The checks never post anything. A server whose database login can't create databases
  needs it allowed first (docs/ACCOUNTANT.md). Imports, Pocket shares and linking a client's own
  Shap are planned.
- 4 November 2026 (the local government elections) is a public holiday in Shap's dates.
- The financial statements aren't compiled until those who approve them are named.

## 1.26.1 (13 November 2026)

From the reviews of Shap Pocket 1.10.1, which shares this code.

- **Share PDF and Email on a draft invoice or credit note ask first.** A draft isn't issued, so it
  isn't in the books (or the VAT) yet, but its PDF said "Tax invoice" and asked to be paid. Now
  they ask: issue it, then share or email it, or send the draft. A draft's PDF and its email say
  "Draft invoice" (or "Draft credit note") and leave out your payment details (bank details, card
  link and PayShap), and so do a voided invoice's.
- **Share PDF, Email and Preview save your changes first, and stop if they can't.** Share and
  Preview carried on with the PDF as last saved; Email didn't save them at all.
- **An invoice's email is named as its PDF is:** "Tax invoice INV-… from …" for a VAT vendor's.
- **Sharing records that it went out,** as emailing does (a quote shared counts as sent, as
  before; cancelling the share sheet doesn't count), so deleting a draft that was shared or
  emailed warns that it has gone out. It didn't know.
- **An error the app or the server didn't expect** now says "That didn’t work. Please let us know:
  tap Feedback, then Bug found." instead of "Something went wrong", and a bug report you send
  carries what failed. The email drawer's own error too, and its title says what's being emailed
  ("Draft invoice …", "Tax invoice …").

## 1.26.0 (11 November 2026)

A VAT-registered business without Sales closes each VAT period, and Workers reminds you where the
law comes in for day labour.

- **VAT period end** (registered for VAT, without Sales switched on): the books close VAT period by
  VAT period, as a business that sells closes each month. By hand (Accounts → Locks shows each VAT
  period's figures, credit notes now among them; Home reminds you from a day you choose in the
  month after it ends, while it's still open), or by itself on that day, whether or not it's been
  checked. Pick a day before your VAT201 is due (on eFiling, the last business day of the month
  after the period; otherwise the 25th): Locks warns after the 25th. Setup asks; it was the year's
  lock before. A business that sells still closes each month, and one neither selling nor
  registered for VAT its years.
  - The year end closes with the year's last VAT period, as it does with its last month: your
    accountant's year-end journals after that need a reopen. Switching to "by itself" when it
    would close a year not yet agreed or approved asks first, and Locks and Home say which year the
    next lock closes.
  - **Books already set up**: each VAT period is closed by hand, with Home reminding you from the
    7th of the month after it (change it under Accounts → Locks). A month end that was set to lock
    by itself while Sales was on, then Sales switched off, is by hand now too: it was a choice
    about months. Switching Sales or VAT registration on or off from now starts the new way by
    hand, and changing the VAT category or the year end never locks anything at once or over a
    reopen.
  - A business that sells: Home now also reminds you of an older month still open, before this
    month's day.
  - The financial statements' page, the partners' profit share, the archive and the books audit see
    a period that has locked itself before the next change is saved.
- **Day labour and the law** (docs/CASUAL_LABOUR.md): Workers now reminds you, from the days logged,
  where labour law comes in. Someone you pay by the day is usually your employee in the law: the
  national minimum wage (R30.23 an hour from 1 March 2026) applies to every worker, and PAYE and
  the Compensation Fund to employees' pay; from 24 hours a month, UIF (1% each) and the Basic
  Conditions of Employment Act's rules on hours and leave too. For PAYE, SARS's tables apply
  to someone working 22 hours a week or more for you, or at least 5 hours a day for under R394 a
  day, and a low wage may come to no tax; otherwise a flat 25%. On the list (about how many hours logged
  in a month, and a day rate under the minimum wage for an 8-hour day), on each worker's page (the
  months they reached about 24 hours), when adding one, and in setup's cautions. Shap still
  records the days and pay only: it doesn't work out, deduct or pay UIF, PAYE or the Compensation
  Fund on day wages. A subcontractor gets the note on when SARS and the labour laws may see them as
  an employee.
  - Payroll's EMP201 says when a month has day wages it doesn't include; Home warns when salaries
    and day wages together over the last 12 months pass R500 000 with SDL off, and with SDL on,
    that Payroll's SDL leaves day wages out; the SDL hints say day wages count.
  - The financial statements: PAYE and the Compensation Fund on day wages are listed for your
    accountant in a year with any day labour, and UIF and leave pay where it reached about 24 hours
    a month; employee costs leave out subcontractors, shown on their own line.
  - These are reminders worked out from the days logged, not advice: Shap is free software from
    OpenWorks IT, who are not accountants or labour lawyers.
- **A fifth review on every update**: the words on screen and what they promise (CPDAUDIT.md).
- The national minimum wage and SARS's deemed standard employment day pay are checked each year
  with the SARS tables.

## 1.25.0 (11 November 2026)

A test server: made-up books for any kind of business, to try Shap out or check its figures.

- **Test server** (switched on on the server, `TEST_SERVER=true`; see docs/TEST_SERVER.md). Set it
  up as any kind of business, then Home → *Fill with made-up data*: the last full financial year
  and this one to date, captured through Shap's own screens as the owner would have: clients,
  quotes, jobs and invoices, payments (some late, some never), costs with made-up slips, and
  whatever the setup uses (payroll and EMP201s, casual workers, counter sales, the till and stock,
  supplier bills, the time tracker, the travel logbook, pro-formas, VAT201s paid, provisional tax,
  dividends, distributions or drawings). The same setup gets the same books (within a financial
  year: docs/TEST_SERVER.md). The figures are made up, and the tax in them is Shap's estimate: Shap
  is free software from OpenWorks IT, who are not accountants. *Wipe and start
  again* goes back to the setup questions; sign-ins stay. A banner on every screen says it's a test
  server, and nothing is shared from it (no anonymous prices, usage notes or feedback). Wiping
  takes the word WIPE and your password. On every other Shap this does nothing.
- `add-company.sh` takes `--test-server` to set one up next to your own Shap (on one CPU and 1 GB
  of memory, so filling it doesn't slow the real companies), and now adds its companies to a plain
  `COMPOSE_FILE` that's already set (for `edge.yml`, say) instead of leaving them out (one it can't
  change safely, it says so before making anything).
- **The financial statements look for three more things** (every Shap, from the test server's
  IFRS review): whether the business is a going concern when liabilities exceed assets or the bank
  is overdrawn at the year end (IFRS for SMEs 3.8; for a company or close corporation, business
  rescue: Companies Act s128, s129(7), CC Act s66(1A)); distributions declared after the year end
  and before the next, disclosed rather than owed (32.8, 32.10); and, selling without keeping stock in Shap, the stock on hand at the year end (13.4). The
  statement of changes in equity names a CC's capital as members' contributions, a trust's as
  capital contributed and a co-op's as members' shares. Checks to help you and your accountant,
  not an opinion on your books.

## 1.24.0 (10 November 2026)

Every sale is a tax invoice, and the books lock month by month for a business that sells.

- **No more cash receipts for sales** (on an accountant's advice to OpenWorks IT; not advice for
  your business: check with your own accountant). Every sale at the counter is an invoice, issued
  and paid on the spot, with the next number in the same series as your other invoices. A walk-in
  needs no details where SARS allows the abridged tax invoice: up to R5 000, and for zero-rated
  goods only up to R50 (a full tax invoice, with the buyer's name and address, is due for anything
  zero-rated over R50 or exported: VAT Act s20(5) and (6)). A business not registered for VAT gets
  "Invoice", not "Tax invoice". The separate sale numbers (SL00001…) and the slip are gone.
- **Add the customer's details** to a walk-in's invoice afterwards, even in a closed month: the same
  invoice and number (before, a sale made an invoice took a second number), saying it replaces the
  abridged one; the one first handed over still prints. A sale's invoice is otherwise never changed,
  paid again (also not from a bank line) or given time.
- Sales made before stay as they were issued: invoices now, each at its own number (SL00012 stays
  SL00012, as the customer has it), reprinting as it was handed over. Where an invoice had the same
  number, a draft one gives way ("-D"); an issued one keeps it and the sale says which number it
  was issued as. An old sale number is never handed out again. The books audit lists old walk-in
  slips with zero-rated goods over R50. In the ledger and the accountant's export, old sales now
  read "Invoice"; they're in the invoice list and the invoices CSV.
- **Month end** (with Sales on): close each month by hand, or let it lock itself on a day of the
  next month; setup asks, and Accounts → Month end & locks shows each month's sales, refunds,
  invoices, costs and bank lines still to tick off. Home reminds you while last month is open. A
  business that doesn't sell keeps the year's lock.
- **Who may lock**: "Close and reopen months and years" is a task in People who sign in. A closed
  period is closed for everyone; reopening takes a reason, kept with the books, and says which
  ended VAT periods it opens (a filed VAT201 is corrected by a revised return; late input tax is
  claimed in the current period). Home shows the books are reopened until they're locked again.
  The lock date is no longer a setting.
- Closed and signed years stay so: undoing a bank match, time put on an issued invoice, a company
  file's agreed year, a move-in into an approved year and a tracker import replacing closed books
  are all refused; reopened approved statements keep the signed set, with its PDF.
- Time goes on a quote or a draft invoice only, with VAT worked out line by line.

## 1.23.2 (10 November 2026)

The tax and SARS rules checked again by an accountant, and every update now goes through four
reviews (CPDAUDIT.md).

- **Small business corporations**: say for each year whether the company qualifies (s12E), on the
  financial statements or the provisional tax screen (the owner or the accountant); a year not
  answered takes the last year's answer. The provisional tax estimate, the financial statements
  and the tax pack all go by it. Until it's said, they show both figures (they used the flat 27%
  unless a provisional estimate for that year said otherwise, so the statements' "income tax" item
  showed the wrong tax). Gross income over R20 million rules the table out. Saving a provisional
  estimate no longer answers the question. All estimates: your accountant confirms the tax.
- The statements' income tax item compares the tax booked with the estimate (a provisional
  payment booked as the expense no longer passes for the year's tax); nothing due on the SBC table
  is nothing to book; "Book the tax" is gone from a year agreed with your accountant (or with a
  later year agreed) or closed, where it changed nothing; a company on turnover tax isn't asked
  for income tax.
- The tax note: the SBC rates' effect on a line of its own when the tax booked is on that table,
  both years' company rates when they differ, and an assessed loss carried forward. Statements
  approved on 1.22 stay approved.
- **Provisional tax paid** (IRP6): the owner records it from the provisional tax screen (only for a
  business taxed on its own profit); it comes off what's owed to SARS for the year's income tax,
  the screen lists what's been paid and takes it off what's still to pay, and the tax pack keeps
  what was paid apart from the tax booked. Deleting any SARS payment is logged. The company file
  carries the SBC answers.
- The small business corporation tables back to 2021 (a year ending 31 March 2023 at 27% above
  R550 000), 2023's medical scheme credits, and **VAT categories D** (six-monthly) and **E**
  (yearly). The dividends tax return named with its DTR02.
- Every SARS figure is listed with its source in docs/SARS.md, and from 1 March each year the
  checks fail until the new tax year's figures are in; the home page says when this version's SARS
  tables end before the tax year you're in.

## 1.23.1 (10 November 2026)

- zod 4 (4.6.7), Shap's checker of everything sent to it: the security update for
  [CVE-2023-54404](https://www.vulncheck.com/advisories/zod-uncontrolled-resource-consumption-via-array-validation)
  (a very long list sent to a server could use up its memory; Shap already refused lists over
  20 000 items before checking them). A refused request still says "Required" or "Invalid" where
  a field has no words of its own; an unknown accountant export and an impossible time in a
  feedback trail are refused rather than server errors.
- People who sign in: "Bank statements" says at the tick what it comes with ("Capture and change
  any cost" and "Record what's paid on them", so also deleting or merging costs and writing off
  invoices).

## 1.23.0 (10 November 2026)

People who sign in, with what each may do; the statements checked against the IFRS for SMEs
Accounting Standard; and a tax pack for your accountant.

- **People who sign in** (Settings): besides the owner and the accountant (read only), everyone is
  staff and does the jobs ticked for them, under a heading for each part of Shap (what's switched
  off isn't shown). Build a **profile** once (Teller, Admin and Site staff come with Shap) and give
  it to each person, changed for them if they do a bit more or less. Change a profile and everyone
  on it has the change at once, except what was changed for them. Site capture logins are now staff
  on the Site staff profile, with the same access as before. See docs/PEOPLE.md.
- A teller sees their own sales and today's takings from them, and stock in quantities only;
  refunds, all sales, stock costs, quotes and invoices, costs, payroll and the reports are each a
  job to tick. Settings, the people who sign in, the year end and approving the statements stay
  the owner's.
- **The IFRS for SMEs check** (docs/IFRS.md): every decision the books and statements make, section
  by section. From it: interest paid and received on lines of their own in the statement of cash
  flows; assets paid personally by a director, financed, or on a bill unpaid at the year end left
  out of the cash flows and told in a note; the legal form and the edition of the standard in the
  general information; the revenue policy worded as Shap books it; and **For your accountant to
  look at** with the checks: the year's income tax (with Shap's estimate, booked with one tap),
  stock above its selling price, work in progress, invoices over a year overdue, leave pay owed.
- **Stock written down** to its selling price (Inventory → Valuation), into stock losses.
- **The public interest score**: worked out from the books for a company or close corporation,
  with what it points to (an audit, an independent review, or a compilation), as an estimate.
- **Close corporations**: the statements carry the accounting officer's report (s62), signed in
  Shap by the accountant or uploaded.
- **Share with your accountant**: the draft statements go from your phone or computer's share (or
  download) with a short note, as in Shap Pocket; email from Shap stays where the server sends it.
- **Tax pack** (Accounts → Export): a year's income statement, Shap's estimate of the income tax
  and your provisional tax estimates, the VAT201s, payroll (EMP201 and EMP501), dividends and the
  assets bought and sold, in one PDF for your accountant.
- Every figure Shap works out for tax or the law says it's an estimate: OpenWorks IT aren't
  accountants, and Shap isn't advice.
- The assessed loss brought forward is worked out year by year (a profit before a loss doesn't use
  it up), and a company's set-off is limited to the greater of R1 million and 80% of its taxable
  income (years ending on or after 31 March 2023), in the IRP6, the statements and the tax pack.
- Statements compiled or approved on 1.22 stay signed after the update: from now on a signed set
  is fingerprinted by the books it came from, so a later Shap drawing them differently isn't a change.
- Staff tracking time see and change their own; the jobs (and their site addresses and notes) are
  for those who see the jobs; the tax pack and books audit leave people's pay out for staff who
  don't see payroll. Reading the reports comes with seeing workers' wages (the ledger shows them),
  and bank statements with capturing costs and payments (as reconciling does).

## 1.22.0 (10 November 2026)

Sales, inventory and the annual financial statements (docs/SALES_AND_STOCK.md, docs/STATEMENTS.md).
Each is switched on in setup, or in Settings → What you use.

- **Sales**: a Sales tab for selling over the counter. Pick items from a quick list (search, and
  with inventory a filter for what's in stock), take the money into the till or the bank, and
  share the slip. Each line keeps its VAT class (standard, zero-rated, export, exempt); a
  business not registered for VAT sells without VAT. Over R5 000, or with an export, Shap asks
  for the customer (a full tax invoice). A sale can be made an invoice afterwards, with the
  customer's details, and refunded: a credit note for what came back, the money paid out, and
  goods in good order back into stock. Sales and refunds are never changed or deleted.
- **Inventory**: stock on hand at weighted average cost. Supplier invoices for stock (paid, or
  bills to pay), with anything short supplied claimed from the supplier; stock sent back; the
  supplier's credit notes settling those claims; stock takes that correct each item with the
  reason, the difference to stock losses; and each item's whole history, linked to its sales,
  invoices and purchases. Selling what isn't in stock is allowed and put right when stock
  arrives or is counted. Everything posts to the books by itself, and the books check now checks
  the stock and the books agree.
- **Financial statements** (Accounts → Financial statements): the year's statements drawn up from
  the books under the IFRS for SMEs Accounting Standard: the statements of financial position,
  comprehensive income, changes in equity and cash flows, the notes, the directors' report and a
  detailed income statement, with last year beside this year. Your accountant compiles them
  (signed in to Shap, or on paper and the signed report uploaded), you approve them, and that
  agrees and closes the year.
- **Where each account goes** on the statements (current or non-current and so on) is set on the
  account in Settings → Chart of accounts; Shap sets it for every account already.
- A new kind of business in setup: **Shop, retail or trading**.
- **Goods returned** on an invoice: a credit note for what came back, back into stock, the money
  paid back or taken off what's still owed.
- **Bills to pay**: a supplier's credit note on account is taken off one of their bills (it waits
  under Bills to pay until it is), so the bill shows what's really owed.
- Reports and the accountant's export up to a past day (a year end) start at that day's
  financial year, instead of refusing.

## 1.21.1 (9 November 2026)

Fixes from the first code scanning (CodeQL) of Shap, and from an independent review of 1.21
(docs/AUDIT.md).

- **The books check** no longer calls correct books wrong: a year agreed at your accountant's
  figures, a cost's VAT rounded the way Shap allows, a year end changed after a year was agreed,
  and old tax invoices after deregistering for VAT all come out clean. Debtors, creditors and
  PAYE now agree to the cent or say so (journals you typed in are counted apart and shown), and
  an agreed year says if anything dated in it was added or changed after it was agreed.
- Splitting a cost never gives a part more VAT than its own amount can hold.
- **Updates** come only from the version that passed every test: if your server can't reach it,
  nothing is updated and Settings says why.
- **Every update's tests** can now fail where before some couldn't, the penetration test checks
  each role is refused exactly, and the upgrade test starts from what servers run.
- **The server check** says when it couldn't check something instead of reporting it fine, checks
  each company's settings file and Shap's folders, and checks each site on the server itself
  first.
- The server's log no longer keeps an email's subject when sending fails, or a database error's
  details; bug reports' steps are cleared of addresses and numbers on the server too.
- Download links on the Accounts screen encode the dates and account they carry, so a typed value
  can only ever be a value.
- Tidying a company registration number no longer uses a pattern that slows down on a long run
  of spaces.
- The version is built into the server instead of being read from a file while it runs.

## 1.21.0 (9 November 2026)

Shap now audits itself: every update, every server and your books (docs/AUDIT.md).

- **Checks** in Settings → Updates & backups: your books checked the way an accountant would
  (everything balances; debtors, creditors, VAT and payroll agree with the invoices, bills,
  VAT201s and EMP201s behind them; agreed years unchanged; tax invoices complete; no invoice
  number missing unexplained), and, on a server set up with deploy/vps, the server's own security
  and privacy check, run every 6 hours.
- **Every update is tested before your server can take it**: the full test suite, a penetration
  test of the running server, a privacy test, an upgrade from the previous version, and known
  vulnerabilities in what Shap is built from. Servers now update from the version that passed
  all of it.
- A date or number out of range in a request is refused plainly instead of failing.
- The server's log no longer keeps searches or email addresses, and bug reports no longer carry
  the names on buttons in lists.

## 1.20.0 (9 November 2026)

- **One tap for payment terms.** On an invoice: due on receipt, in 7, 14 or 30 days, or at month
  end; on a quote: valid for 7, 14, 30 or 60 days. A tap sets the date and changes the wording in
  the terms to match (“Payment due within 30 days”). Changing the invoice date keeps the term.
  Settings (and setup) have the same choices for the usual terms.
- **Calmer how-it-works clips.** Re-recorded slower, a few steps each, with a caption above the
  screen saying what each step is.
- “1 cost”, not “1 costs”.

## 1.19.0 (9 November 2026)

- **Issued tax invoices are fixed.** Once a VAT vendor's invoice is issued, its items and
  prices, the client, the date, the number and the trading name can't change: SARS allows one
  tax invoice per supply. Correct one with a credit note, and a new invoice for anything extra.
  The due date, notes, terms and payment link can still change. Invoices from a business that
  isn't registered for VAT stay open to change, as before.
- **Clips full screen.** Tap a how-it-works clip to watch it over the whole screen. It plays once
  and goes small again by itself; tap anywhere to close it sooner.

## 1.18.0 (9 November 2026)

VAT the way the accountant asked for it, and short clips that show how each screen works.

- **How-it-works clips.** The first time each main screen opens, a few seconds of it being used,
  with what it's for. Put one away and it stays away. Settings → What you use switches them off,
  or shows them all again.
- **VAT per item.** Each item on a quote, invoice or credit note says what kind of supply it is:
  standard rate (15%), zero-rated, exported or exempt, with a short explanation of each from SARS's
  rules. The VAT is worked out on the standard-rated items only, and the VAT201 puts each kind in
  its own field (1, 2, 2A and 3). A credit note keeps its invoice's choices.
- **Prices including or excluding VAT.** Type prices either way; including VAT, the total is
  exactly what you typed and the VAT is worked out from it. The PDF says which, shows the VAT on
  each item, and lists what was zero-rated or exempt.
- **Costs and bills say what VAT was on them:** standard (claim it), zero-rated, exempt, a
  supplier who isn't VAT registered, or VAT that can't be claimed (entertainment, a passenger
  car). Only standard-rated VAT is claimed.
- **The VAT rate by date:** SARS's standard rate on each document's own date (14% before
  April 2018), instead of a setting.
- **Tax invoices, tightened** (from an independent review of this release):
  - A tax invoice or credit note needs your VAT number and business address before it's issued.
  - One with zero-rated or exported items always shows the client's name and address (the short
    form isn't allowed for zero-rated supplies), and a credit note needs them whenever the invoice
    it credits did.
  - A draft made before you registered for VAT charges VAT when it's issued after, and a PDF says
    “Tax invoice” by the invoice's own VAT, not today's registration.
  - An issued invoice keeps how its prices were typed (including or excluding VAT).
  - Monthly invoices keep each item's VAT and how prices were typed. One that can't go out as a
    tax invoice isn't sent, and Home says why.
  - Invoices a VAT vendor issued at 0% before this version count as zero-rated. Invoices from
    before registering, and credit notes on them, aren't on the VAT201.
- A bad debt on an invoice that mixed standard-rated with zero-rated or exempt items claims back
  only the VAT still in it, allowing for credit notes. The accountant's export gives each line its
  own tax type.
- **The VAT registration line** is held against the line of its day: 12 months that passed
  R1 million before 1 April 2026 meant registering then, though today's line is R2.3 million.
- **Numbers people really have:** a client abroad's VAT number (starting with their country code),
  and passport numbers of digits only. A number from before the checks that isn't being changed
  doesn't stop an edit. The EMP501 shows SARS's UIF reference (U and nine digits), and marks the
  filing dates as the usual ones (SARS announces each season's).

## 1.17.0 (9 November 2026)

The accountant's review.

- **Terms of use.** Setup now ends with the terms of use: the few points that matter (Shap is a
  record-keeping tool, not an accountant; what you file and pay, your backups and your updates
  are yours to look after), said back with what your own answers mean. Books set up before this
  are asked once to accept them. The version and the date are kept in your books and audit log.
- **Tax invoices as the VAT Act lays them out.** A VAT vendor's invoice always says “Tax invoice”
  (zero-rated too), and shows the total excluding VAT, the VAT and the total including VAT. A tax
  invoice over R5 000 can't be issued without the client's name and address, and a credit note
  without its reason (now kept when the draft is edited).
- **Numbers in the right shape.** VAT numbers, income tax numbers, PAYE and UIF references, ID
  numbers and company registration numbers are checked as they're typed (and called by their
  full names). Switching VAT on needs a VAT number.
- **Employers.** Setup asks whether you're registered for PAYE, UIF and SDL, with what to do if
  not. The new EMP501 reconciliation (Payroll → SARS) checks the interim and annual periods'
  EMP201s against payments and each employee's IRP5 or IT3(a), with SARS's source codes.
- **The VAT line in any 12 months in a row**, not just the last 12: Shap shows when your income
  first crossed it.
- **Dividends always on** for a company, Inc., CC or co-op: every dividend is declared to SARS.
- **Preview a PDF** on screen before sending it, with its own zoom.
- **Audit log** in Settings: every change, sign-in and export, with a spreadsheet download. It's
  in every backup. Deleting a quote, invoice, credit note or cost first says what SARS expects
  about keeping records, and what was deleted stays in the log.
- **Notices from OpenWorks**: a short message across the top of the app for the rare news
  everyone must hear, such as a needed update or, one day, support ending (see SUNSET.md).
- “Lines” are now **Items and services**. Anonymous prices share the **average** price, not the
  middle one. Setup says plainly that stock (inventory) tracking isn't there yet.
- Settings → Updates & backups says plainly that updating (it needs an internet connection) and
  backups are yours to do, and links the terms.

## 1.16.1 (7 November 2026)

- **The anonymous usage note** (only if you said yes to it) is now also sent after an update and
  about once a month while Shap is used, so OpenWorks can tell how many people still use Shap and
  how many have taken each update. It still holds no names, clients or figures: just the app,
  version, kind of business and which features are on. Switch it off any time in Settings.
- For OpenWorks’ own collector: each usage note remembers when that install was first heard from,
  and when it last updated and from which version.

## 1.16.0 (6 November 2026)

A full review of the figures, the tax rules and the security, with what it found put right.

**Figures that came out wrong**

- **Bad debts:** writing off an invoice now claims the VAT in it back in the books, as the VAT201
  already did (field 17). Before, the whole amount went to bad debts, so the VAT account didn’t
  agree with the return and profit was understated by the VAT. Years already closed stay as they
  were.
- **The bank and bills:** a statement line is matched to the payment made on a supplier bill,
  never to the bill itself (that paid it twice). The match screen now also offers payments
  recorded on bills and invoices, refunds and journals on that account.
- **Transfers:** the second side of a transfer between two of your accounts is ticked off against
  the journal already there, instead of moving the money twice.
- A payment recorded into another account (Cash, say) and matched to a bank line now moves to the
  bank, and back again if you unmatch it.
- **EMP201 in parts:** paying a month’s PAYE, UIF and SDL in two goes now clears each tax in turn,
  as paying at once would.
- **Dividends** are closed into retained earnings at each year end, as an accountant’s trial
  balance shows them. Years already agreed keep the figures they had.
- A job marked finished or cancelled takes its costs to cost of sales on that day, not back on
  the dates they were spent (which could be in a closed year).

**A closed year stays closed**

- An agreed year can’t be changed or removed while it’s locked, and agreeing a year now pins every
  account, so a later change can’t quietly move its figures.
- Moving a cost type or an account to another account in the books, or changing an account’s
  type, is refused once a closed year has postings on it.
- A job finished in a closed year can’t be reopened.

**Tax**

- **Retirement annuities:** the deduction cap is R430 000 from the year to February 2027
  (Budget 2026; it was R350 000).
- **Provisional tax:** a sole proprietor with a salary can enter the PAYE already taken off it,
  and it comes off the payments as SARS works them out.
- **Payroll:** overtime and commission are regular pay, taxed with the salary. A bonus is taxed on
  top of any earlier bonus that tax year, and commission no longer counts for UIF. The EMP201
  month is the month the pay was paid, so February’s run paid on 1 March is on March’s EMP201.
  Payslips and the tax-year totals show salary, overtime, commission and bonus apart, with their
  IRP5 codes.
- **Turnover tax:** half of what selling the business’s assets brought in counts as turnover. An
  individual’s interest doesn’t (there’s a new “Interest received” account for it). A micro
  business pays no dividends tax on its first R200 000 of dividends a year.
- **VAT on assets:** an asset bought straight from the bank can claim its VAT, and selling one
  charges VAT (fields 1A and 4A), with the profit worked out before VAT. A motor car (sedan,
  station wagon, minibus or double cab) gets no VAT back and charges none when it’s sold. VAT on
  costs moved onto the asset register goes in field 14.
- A cost’s VAT can’t be more than its amount can hold, and personal spending claims none.
- Older years use their own tax tables (2023 rates, the 28% company rate before April 2023, and
  the R1 million turnover tax limit before 2026/27).
- Due dates move back over public holidays, not just weekends.
- Rounding to the cent now matches the database exactly (halves away from zero).

**Security**

- A request with a list of millions of items is turned away at once instead of tying up the
  server.
- A change from someone who isn’t signed in is refused before its body is read.
- New recovery codes need your password and a fresh authenticator code, and wrong codes count
  toward the sign-in limit.
- Site staff can’t pile up a worker’s days by editing an entry afterwards.
- Slip photos can only be swapped for smaller ones in a closed year, and each swap is logged.
  Stored files of any other type are only ever downloaded, never opened as a page.
- Leaving the lock date or market-rate sharing out of a settings save no longer changes them.
- The anonymous collector keeps no sender addresses or install ids, and it limits how much any
  one sender, month or item can add.
- Deploying: secrets stay out of the Docker build, added companies get the same container
  hardening, and the root helper can’t be made to hang.

## 1.15.0 (6 November 2026)

- **Every kind of South African business.** As well as sole proprietors and (Pty) Ltd companies:
  partnerships, close corporations, business (trading) trusts, Inc. companies, non-profit
  companies and co-operatives. Choose it in setup (“A partnership, CC, trust or something else”)
  or in Settings. Each one gets:
  - its own names in the books (a CC’s “Members’ contributions” and “Members’ loan accounts”, a
    trust’s “Trust capital” and “Accumulated profit”, and so on), with names you chose left alone;
  - its own year end (sole proprietors, partnerships and trusts on SARS’s year to February);
  - its own way of paying the owners: dividends, a CC’s distributions to members (with dividends
    tax), a trust’s distributions to beneficiaries (no dividends tax), or drawings;
  - the right tax estimate: company or small business rates, the individual tables, 45% on what a
    trust keeps, or none for an approved PBO;
  - the right SARS and CIPC guides, including new ones for the trust return (ITR12T and IT3(t)),
    tax-exempt organisations (IT12EI), CIPC annual returns with beneficial ownership, and
    co-operatives.
- **Partnerships, properly.** Each partner has a capital account, a current account and their own
  “Paid personally”, and a share of the profit. At the year end, Accounts → Year end shares the
  year’s profit (or loss) into their current accounts in one tap, and the tax estimate and turnover
  tax are worked out on each partner’s share.
- **Trusts:** each distribution says whether it’s this year’s income to a beneficiary living in
  South Africa (taxed in their hands, so it comes off the trust’s taxable income) or not (given to
  someone abroad, or out of capital: the trust pays).
- A company, CC or co-op on turnover tax needs its year end in February (SARS’s rule): Settings
  now says so.

## 1.14.0 (5 November 2026)

- **Anonymous prices, to help show what work typically costs.** Once a month, Shap shares the
  middle price you charged last month for each of your trade's standard items (like "Tiling",
  per m²), from issued invoices: never your name, clients, the invoices, anything you typed or
  totals. OpenWorks' server adds them into national totals as they arrive and keeps only the
  totals, so that one day South Africa's trades and their clients can see what a fair price
  looks like. Never for advertising or marketing. It's on unless you switch it off (Settings →
  What you use), and nothing is shared until you've been told: a note on Home says what's shared,
  with a button to switch it off. New businesses see it during setup.

## 1.13.1 (4 November 2026)

The rest of the security review: the files and text that come into Shap from outside.

- **A damaged logo can no longer stop Shap.** A logo is now checked when you upload it (one that
  can't be read is refused, with a message), and again before it goes on a quote or invoice. Before,
  a damaged PNG logo could stop the whole server on the next PDF, the monthly invoices included.
  Logos already saved are checked too: one that can't be read is left off the PDF.
- **Imports can't hold Shap up for everyone.** Bank statements, the tracker workbook, moving in
  and client CSVs have sensible limits (no cell longer than 4 000 characters, 100 000 rows, 5 000
  clients in one client file, a workbook of 64 MB unpacked), so a crafted file can't freeze the
  server or use up its memory. Real files are well inside them.
- **Exports are safer to open in Excel.** Text that a spreadsheet could run as a formula is
  neutralised wherever Excel might start a new cell, not just at the start, whichever list
  separator (comma or semicolon) your Excel uses.
- **A company file is checked as if typed into Settings:** a value that isn't valid (a colour
  that isn't a colour, text that's far too long) is refused, and a logo in it that can't be read
  is left out.
- For OpenWorks' feedback collector: no single address can use up a day's room, and a day's
  screenshots have a ceiling.
- If Shap ever stops on an unexpected error, the log now says what it was before the container
  restarts it.

## 1.13.0 (4 November 2026)

A security review and penetration test, with the findings fixed. Most of this is behind the
scenes; a few things you'll notice:

- **The demo company is sealed off from your real books.** While you're showing the demo, it can
  no longer reach your real feedback, the server (updates & backups) screen, or your business's
  real name — not even through an oddly-typed web address.
- **Setting up or replacing two-factor sign-in now asks for your password** (every time, including
  the first), so a phone left unlocked can't move your two-factor to someone else's device.
- **Resetting someone's two-factor now signs them out everywhere**, and asks for your password —
  so a lost phone loses its access straight away.
- **Making someone an owner, or resetting another person's password or two-factor, asks for your
  password first.** A session left open can no longer be used to quietly take over.
- **Sign-in, two-factor and password limits now hold under a flood of simultaneous attempts**, not
  only one-at-a-time; a code or recovery code can be used once, even against a burst of tries.
- **Site staff stay on-site:** they can't set VAT, raise supplier bills, enter negative costs, pay
  from an internal account, or pile up a worker's days; and they no longer see a job's billing
  rate, part prices, or the full supplier list (only their own).
- **The System screen shows only this company's own backups.**
- **Closed years are better protected:** an asset's cost can no longer be changed once its year is
  locked.
- Uploaded receipts and statements are served more defensively, and dependencies were updated.

**For self-hosters:** the app now runs with fewer privileges and reads the server's status from a
read-only folder, with a separate drop-box for its requests. Re-run
`deploy/vps/ctl/install.sh` once after updating so the folders are set up (the app keeps working
either way; this just restores the updates & backups screen). See the hardening notes in
`docs/deployment.md` for the optional least-privilege database login and signed-release updates.

## 1.12.1 (2 November 2026)

- **Setting up asks about the new parts:** do you charge by the hour (with your usual rate),
  drive for work (the travel logbook), get supplier bills on account, take payment up front
  (pro-formas), or come from another package (Move in opens straight after). The answers start
  from what's usual for your kind of business. Your PayShap ID, turnover tax and how often you
  file VAT can be set up there too.
- **A usual hourly rate** (Settings → Invoicing & tax): for time with no job, and jobs without
  their own rate.

## 1.12.0 (2 November 2026)

Moving in from another package.

- **Move in** (Settings → Import & company file): the CSV exports of Sage Accounting, Xero,
  QuickBooks Online, Zoho Invoice / Books or Invoice Ninja. Clients, invoices with what's been
  paid (or the payments export, with its dates), quotes, items, bills and expenses, and the trial
  balance at your last year end as the opening balances, mapped to Shap's accounts. Each file is
  recognised by its columns; a preview shows what comes in before anything is saved, and it all
  goes in together or not at all. The numbering carries on from the old package's.
- Imported items join the usual items offered when you add a line.
- Long lists no longer push screens wider than a phone.

## 1.11.0 (2 November 2026)

More of what a small business needs, each one a switch under Settings → What you use (now
grouped: Work, Invoicing, Money and tax).

- **Credit notes:** take back part or all of an issued invoice (a return, a discount, a
  mistake), with their own numbers (CN0001…). Issued, a credit note comes off the invoice's
  balance and its VAT off the VAT return. Void it to undo; an invoice with credit notes can't be
  voided.
- **Pro-forma invoices:** ask to be paid before the work starts. Their own numbers, "not a tax
  invoice" on the PDF, and turned into a real invoice once paid.
- **PayShap:** your ShapID printed on unpaid invoices and pro-formas, and in the email, so
  clients pay instantly from their banking app.
- **Payment reminders:** Home lists overdue invoices (part-paid ones too). With email set up and
  a client email address, one tap emails the reminder with the invoice attached; otherwise the
  PDF downloads (or opens the share sheet on a phone) with a friendly message copied to paste
  into WhatsApp. Each reminder is noted on the invoice.
- **VAT201:** the return box by box for each period (category A, B or C), with the due date;
  Home reminds you when one is coming up.
- **Turnover tax:** for micro businesses registered for it, the tax tab switches to turnover tax
  on SARS's 2026/27 table (up to R2.3 million), with the two interim payments.
- **Supplier bills:** costs you'll pay later, what's owed and when it's due, paid off from
  Bills to pay; Home shows bills due this week.
- **Travel logbook:** SARS's logbook (trips, odometer at the start and end of the tax year,
  business share), downloaded as a spreadsheet.
- **Time tracker:** a clock per job and per person (each owner runs their own), an hourly rate
  on the job, and unbilled time onto an invoice in one tap ("Add time…").
- **SARS filing guides:** step by step through VAT201, provisional tax, ITR12, ITR14, EMP201,
  EMP501, turnover tax and dividends tax, with where each figure is in Shap. We're not
  accountants: only file yourself if you're lekker with some accounting.
- **For your accountant** (Accounts → Export): the books laid out for Sage 50 / Pastel, Xero,
  QuickBooks Online or Sage Accounting (journal, sales, purchases, payments, debtors age
  analysis), with a preview and the total to check after importing.
- **Wipe all data** (Settings → Updates & backups): back up first, then type the business's
  name and your password. The books start over from the first-run questions; the people who sign
  in and the audit log stay.
- **Several people at once:** open screens refresh when someone else saves, and an
  out-of-date invoice screen can't overwrite a newer save.
- **Slips kept grey and small** (about a fifth of the size), and closed years can be archived to
  squeeze their slips again (Accounts → Year end).
- **Reports fast on big books:** per-account totals are cached; tested on ten busy years.
- Fixed: saving one Settings tab no longer undoes a switch flipped a moment before on another.

## 1.10.0 (2 November 2026)

- **Fitted to your kind of business.** Settings → What you use → *Your kind of business* now
  runs through the app: the examples in forms (a designer no longer sees cement), the names of
  line types on quotes, invoices and their PDFs (Services / Products for a salon, Design / Print
  & production for a designer; builders and books that haven't said keep Labour / Materials /
  Demo), units, and the cost types a trade needs (chair rent, salon stock, stock images, lens
  hire…), added once, with builder-only ones put away. New expense accounts: Rent, Training &
  courses, Printing & stationery, Equipment hire.
- **Usual items** under a quote's or invoice's lines: what you've charged before with last
  time's price, then the common items for your trade. One tap adds the line.
- **New client from the quote or invoice** ("+ New client…" in the Client box), and invoices
  with no client yet ("No name yet"): add the name later.
- **The Shap line**: a small line at the foot of quotes, invoices and payslips ("Made with Shap:
  keeps the books lekker so South Africa can get to work…"). On by default; switch it off in
  Settings → What you use → How Shap talks to you.
- **Support Shap** in Settings: *Tell us what you need* opens feedback on a new 💡 Idea kind,
  and *Buy us a coffee* goes to openworks.co.za/shap (set `VITE_SUPPORT_URL` at build time to
  change it). The first-run questions mention that Shap is free, open and never has ads.
- **Feedback is kept for a year.** Reports and anonymous usage notes older than 12 months are
  deleted once a day (as the privacy policy at openworks.co.za/shap/privacy says).
- **Quicker screens**: coming back to a screen shows what it showed last time straight away and
  refreshes underneath; Home skips the parts you've switched off.

## 1.9.0 (2 November 2026)

- **Payroll.** Settings → What you use → *Payroll*. Employees on a monthly salary; each month's
  pay run works out PAYE on SARS's tables (annualised, with the rebates for their age and medical
  scheme credits), UIF (1% + 1%, up to R17 712 a month) and, if you're registered, SDL. Add a
  bonus or overtime for the month, finalise, and it's in the books (salaries or director's
  remuneration, PAYE/UIF/SDL owed, net pay from the bank). Payslip PDFs to share, the EMP201
  amount with its due date (7th), *Paid SARS* to clear it, and the tax year's totals per
  employee for IRP5s. Home reminds you when SARS is due or late.
- **Dividends** (companies). Declare a dividend to a shareholder (you): 20% dividends tax is
  withheld and owed to SARS by the end of the next month; paid now or later; shows the profits
  available to pay out.
- **New books start with a few questions**: company or sole proprietor (and VAT), what you do,
  employees / casual labour / dividends, how your work runs (quote → job → invoice, quote →
  invoice, or just invoices), logo, invoice details, formal or casual. Shap switches on only
  what you need. Your existing books are untouched: everything you use stays on.
- **What you use** (Settings): switch jobs, quotes, casual workers, payroll, dividends, bank
  statements, assets and trading names on or off.
- **Formal or casual**: "Howzit" and "Lekker!" or "Good morning" and plain confirmations.
- **Feedback button** on every screen (from Sorted): love it, don't like it, or a bug with a
  masked screenshot and the steps before it. The owner reads them under Settings → Feedback;
  they're passed on to OpenWorks too (`COLLECTOR_URL=off` to stop that).
- **Card payment link** (Yoco, SnapScan…): a usual one in Settings and one per invoice, printed
  on unpaid invoices and added to the email.
- **Logo placing**: drag, size and centre the logo in its box on the PDF (per trading name, or
  for the business when there's one name).
- OpenWorks' server (`COLLECT=true`) receives feedback and anonymous usage notes from Shap Pocket.

## 1.8.0 (1 November 2026)

- **Sole proprietors.** Settings → Invoicing & books → *This business is*: a company, or just
  you trading in your own name. For a sole proprietor:
  - the provisional tax estimate uses SARS's **tables for individuals** (2027: 18% to
    R245 100 … 45% above R1 878 600) with the rebates for your age, plus any other taxable
    income (a salary, interest, rent) and your retirement annuity deduction (up to 27.5% of
    income, at most R350 000);
  - the year ends in February (SARS's year for individuals);
  - the owner's loan account becomes **Owner's capital and drawings**, shown under equity:
    what you take out is drawings, not a cost. A name you gave it yourself stays.
- **VAT threshold watch.** Not registered for VAT? Shap adds up the last 12 months' income
  and warns on Home when it's within 20% of the line where registering becomes compulsory,
  or the last three months are running past it, and says plainly when it's over (register
  within 21 days). The line is **R2.3 million from 1 April 2026** (R1 million before); you may
  register voluntarily from R120 000. Settings shows where you stand. VAT stays a switch.
- The provisional tax sheet fits a phone screen.

## 1.7.0 (30 October 2026)

- **Monthly invoices.** On an invoice, *Make monthly…*: pick the day of the month and whether
  Shap emails it to the client by itself or leaves a draft for you to check. On that day it
  makes a copy of the latest invoice in the series, with the next number and any month in the
  heading, lines or message (“October 2026”, “Oct 2026”) moved on. Change the latest invoice
  (a new price, say) and the next ones follow. The 31st becomes the last day of short months;
  an optional end date stops it; *Stop* and *Start again* are on the invoice.
  - Never twice for the same month, and if the server was off it catches up (up to three
    months). Making an old invoice monthly starts from today, never filling in the months
    between.
  - It waits while the books are closed for that date, and Home says why.
  - Home lists the ones that didn’t work (with the reason) and the drafts waiting for you.
    *Try again* on the invoice sends any that were made but not emailed.
  - Quotes & invoices lists every monthly invoice and when the next one is due.
- **Email setup**: the email shows the invoice’s trading name as the sender, so one mailbox
  serves every trading name (replies still go to that trading name’s email). Shap checks the
  mailbox when it starts and logs what’s wrong if it can’t sign in, and a failed email now says
  why (wrong password, server not found, wrong port) instead of “Something went wrong”. Setup
  steps: *docs/deployment.md*, “Email”.

## 1.6.0 (23 October 2026)

Security: a full review and break-in testing of sign-in, sessions and every route. Update
soon.

- **Password guessing is limited per account**, not only per address: eight wrong passwords in
  15 minutes and that account waits, however many addresses the guesses come from. Two-factor
  codes the same (six wrong tries). An email that has no account behaves exactly the same, so
  this doesn't reveal who has one.
- **An open session can't take your account.** Changing your own email or password, moving
  your two-factor to a new phone, resetting your own two-factor, downloading a backup, saving
  or loading the company file, and leaving the demo company all ask for your password first.
- **Change your own password**: tap your name (top right) → *Change my password*. Everyone
  else signed in as you is signed out; you stay in.
- **Better passwords**: still at least 10 characters, but the passwords people guess first
  (and ones made of your own name or email) are refused, with a hint as you type.
- **Other websites can't act with your session**: every change must come from Shap's own pages.
- **Site staff** no longer see a job's quoted figures or the bank details on your trading
  names, and can open only the costs and slips they captured.
- **Uploads must really be photos or PDFs**; spreadsheet exports neutralise anything that
  would run as a formula; the app's pages carry a content security policy (only Shap's own
  scripts, never inside another site's frame); the address used for sign-in limits can't be
  faked through a forwarded header.
- Every one of these is now a test, along with a check of all 151 routes: nothing opens when
  signed out, the accountant can't change anything, site staff can only log work.

## 1.5.0 (21 October 2026)

- **Show the demo company.** Settings → *Show the demo company* swaps this phone or browser over
  to a made-up company (Demo Builders: jobs, quotes, invoices, workers, a year of books) so you
  can show Shap to someone without your own figures on screen. A blue bar across the top says
  it's the demo the whole time.
  - It's a separate database next to yours: nothing from your books can show, and anything a
    visitor adds or changes stays in the demo. It never emails anyone, and the server's
    updates and backups can't be reached from it.
  - **Back to my books** asks for your password, in case the phone was handed over.
  - **Reset demo** puts it back as new, with its dates brought up to today.
  - Shap creates the demo database itself the first time (nothing to set up). It isn't
    backed up. `DEMO_ENABLED=false` turns it off.

## 1.4.0 (21 October 2026)

- **Monthly costs.** Shap learns which running costs come every month (insurance, bank fees,
  subscriptions, cellphone, rent) from what you've captured: any cost type and supplier seen
  three months in a row. When one doesn't show up (a few days after its usual day this month,
  or a month that was skipped altogether), Home says so until it's sorted. Costs → *Monthly
  costs* shows each with its usual amount and day and the last seven months.
  - **Add it**: opens a cost already filled in (amount, type, supplier, account, date).
  - **On the statement, not captured yet**: when a bank line looks like the missing one.
  - **Skip** a month (a payment holiday), or **Stop watching** one you cancelled.
  - Gone for more than three months, it's taken as stopped and the warnings end. Job
    materials aren't watched: they come and go with the work.

## 1.3.0 (21 October 2026)

- **Intangible assets.** The asset register takes *Patents & trade marks* and *Software
  licences* (bought outright). They sit under **Intangible assets** on the balance sheet and
  are written off as **amortisation** (not depreciation), a month at a time. A patent starts at
  10 years (up to 20 is allowed). To record an attorney's patent fee: capture the cost, then
  *This is an asset… → Patents & trade marks*.
- **IT costs.** New cost types **Software & subscriptions** (AI and other subscriptions, SaaS)
  and **Hosting, servers & domains** (VPS rentals, domains, cloud), each with its own line in
  the income statement. Computers and phones that last years stay assets (3 years).
- **Change the type of many costs at once.** Filter Costs by a type (your old "IT expenses",
  say), tick them, and *Change type to…*.
- A new asset's life now starts at the usual one for its kind.

## 1.2.2 (21 October 2026)

- **Split a cost paid more than one way.** Open the cost and choose *Paid more than one way?
  Split it*: R1,300 becomes R650 cash and R650 from the bank (or any number of parts, up to
  ten), each saying where it was paid from. Each part keeps the job, type, supplier and slip;
  VAT is shared out in proportion. The bank part can then be matched to its statement line.
  A cost already matched to a statement line is unmatched first.

## 1.2.1 (21 October 2026)

- **Telling Shap a suggestion is wrong.** Every place that suggests something now takes a
  "no", remembers it, and stops suggesting it:
  - *Costs counted twice*: **Not the same** on a pair (or on all ticked ones). It leaves the
    list and the Home reminder for good. *Marked not the same* lists them to bring one back.
  - *Bank statements*: **Not this** on a suggested match is now saved (it used to come back
    whenever the page reloaded). The next best match is offered instead, if there is one, and a
    line you've turned down "Already captured?" for is no longer held back when you add it.
    *Show turned down* on the line brings them back.
  - Turning a cost down as a bank line's match also means the two aren't paired later as
    counted twice.
  - *Imported statements*: a statement flagged as also on another account can be marked
    **It's fine** (transfers between your own accounts), and flagged again.

## 1.2.0 (20 October 2026)

Bank statements and costs counted twice, reworked and tested end to end on a replay of a real
year of statements.

- **A statement can't go in under the wrong account by accident.** Importing a file whose
  transactions are already under another account (or the same file name) is stopped with a
  warning naming that account; you can still import it after ticking that it really belongs
  there. This was the cause of most costs being counted twice.
- **Costs counted twice, rebuilt.** Only two cases are listed, both certain: the same bank
  transaction imported twice and turned into two costs, and a slip you captured that was then
  added again from the statement. Two costs you captured yourself are never paired (the same
  shop sells many things at nearly the same price). Merging keeps the cost on the job and
  removes the copy together with its extra statement line.
- **Every merge can be undone**, from *Recent merges* on the same screen, exactly as it was.
- **Ticks stay yours.** The review screen and the bank to-do list no longer re-tick
  everything after a merge or a match, and *Not this* is remembered.
- **One problem doesn't stop the rest.** A pair or a statement line in the closed period
  (before the lock date) is left with a note; the others still go through.
- **Already captured? is suggested, not added.** A statement line that looks like a slip you
  captured days earlier is offered as a match (never automatically) instead of being added as
  a new cost.
- **Imported statements** shows how many costs were added from each, and flags one whose
  transactions are also on another account. *Take out with what was added* removes a statement
  as if it was never imported. Unmatching, or deleting a statement, now gives costs back the
  account and amount they had before they were matched.
- **Out-of-date pages can't save.** If Shap is updated while a page is open, it says so and
  asks you to reload; until then the server refuses changes from it.
- **Restoring a backup**: the instructions in docs/backups.md were wrong for a backup from an
  older version; they now create the database fresh.

## 1.1.6 (20 October 2026)

- **Costs counted twice, rethought**: it only looked at costs added from a bank statement whose
  twin wasn't tied to the bank, so plenty of real doubles never showed. Now any two costs from
  the same supplier, of the same amount (give or take R1), within 12 days are compared, as long
  as one of them has no job or came from a statement. The one kept is the one on a job, then
  the one you captured, then the one with a slip.
- Pairs the bank shows as two separate payments are listed too, marked *check*, unticked:
  merging one puts the removed cost's statement line back on the to-do list.

## 1.1.5 (20 October 2026)

- **Fewer false twins**: *Costs counted twice* paired costs on amount and date alone, so a car
  wash and an electrical slip of R300 could show as one purchase. Now the supplier's name has to
  match too. Same amount on the same day with different names is listed as *different names:
  check*, unticked.
- **Merging by hand** a cost that the bank shows as a separate payment now works: the copy's
  statement line goes back on the to-do list, for you to leave off or match.
- **Updates show straight away**: after an update the app reloads itself with the new version
  (it checks when you open it or come back to the tab), instead of needing a hard refresh.

## 1.1.4 (20 October 2026)

- **More twins found**: *Costs counted twice* now also lists a statement copy when the cost you
  captured was already tied to the bank, as long as it's the same transaction imported twice
  (the same date and amount in two different statement files), and when the copy's statement
  has since been deleted. Merging also removes the extra statement line. Two real payments of
  the same amount are never folded together.
- **Merge by hand**: open any cost and choose *Counted twice? Find the other one*. It lists
  costs of about the same amount within two weeks; keep this one or that one. The one kept
  takes the other's job, slip and supplier if it had none.

## 1.1.3 (20 October 2026)

- **Statement under the wrong account**: Bank → *Imported statements* lists what you've imported
  for an account. *Move to this account* takes a statement imported under the wrong one (a
  card's statement loaded as the bank's) to the right one: its lines, and every cost, payment
  or entry matched to or added from them, now say they were paid from the right account. Lines
  already imported there are kept once. A transfer that would now be from an account to itself
  is undone, so you can book it again. Statements can be deleted there too.

## 1.1.2 (20 October 2026)

- **Costs counted twice**: a statement line paid for something you'd already captured on a
  job, but from a different account (or a few days earlier), wasn't recognised, so ticking it
  added a second cost with no job. Statement lines are now checked against everything captured
  around that date, whichever account it says paid; the suggestion names the job.
- **Held back, not added twice**: ticking a line that looks already captured no longer adds it;
  you're told to check its suggestion. Choosing *Not this* on the suggestion still lets you add it.
- **Merge the ones already in**: Costs → *Find ones counted twice* (also on Home) lists costs
  added from a statement next to the one you'd captured. Merging keeps yours (job, type, slip),
  records that the statement paid it, and removes the copy.

## 1.1.1 (19 October 2026)

- **Sharing the server**: Caddy now reaches Shap by its own name (`shap-app`). With other apps
  on the shared `edge` network, another app's container called `app` could answer for Shap's
  address instead.

## 1.1.0 (19 October 2026)

- **Bank statements**: a match can be a few cents out (a supplier's or the bank's rounding);
  the biggest item takes the difference so the books follow the statement. Money in that isn't
  a client payment can be booked as income (interest, cashback) or as a refund on a cost type.
- **Statement PDFs**: keep each account's monthly bank statement on file (Accounts → Statement
  PDFs), for you and the accountant. Choose which accounts need them under Settings → Lists;
  Home reminds you of months still to upload.
- **Workers**: an advance can be settled from the worker's page: say it was work on a job, a
  bonus or general work, and the job's costs and the worker's balance follow, back to that date.
- **Jobs close themselves**: once a job is fully invoiced and its invoices are paid (or written
  off as delinquent), it's marked done. Jobs still waiting on quoted work stay open.
- **Parts without a job**: tick them and put them on a job, mark them as not for a job, or change
  their type (advertising, entertainment); either way they leave the list.

## 1.0.0 (19 October 2026)

The first version running a real business's books.

- **Jobs, labour and costs** from the site on a phone: crew days, slips with photos, wages and
  savings, parts plans, and every job's quoted, spent and invoiced side by side.
- **Quotes and invoices** under either trading name (logo, colour, bank details), with deposits,
  a job made straight from a quote or invoice, and no zeros to delete on new lines.
- **Delinquent invoices**: write off what won't be paid as a bad debt, and undo it if they pay.
- **The books** built live from what you capture: income statement, balance sheet, ledger,
  journals, asset register, balance checks, and agreeing a year to the accountant's figures.
- **Provisional tax** estimates on the SARS small business tables.
- **Bank statements**: import the CSV and reconcile it, including slips captured item by item,
  debit orders and bank fees never captured, client payments and transfers.
- **Your tracker and Invoice Ninja clients** brought across, checked against your sheets.
- **Updates and backups from Settings**: see the version, update with one button, back up every
  night and before each update, with copies fetched to your PC.
