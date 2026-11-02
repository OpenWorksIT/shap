# Changelog

What changed in each version of Shap, newest first. Settings → Updates & backups shows the
entries newer than the version you're running before you update.

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
