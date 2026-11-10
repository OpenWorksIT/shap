# Changelog

What changed in each version of Shap Pocket, newest first.

## 1.7.2 (10 November 2026)

The tax and SARS rules checked again by an accountant (from Shap 1.23.2).

- **Small business corporations**: say for each year whether the company qualifies (s12E), on the
  financial statements or the provisional tax screen; a year not answered takes the last year's
  answer. The provisional tax estimate, the financial statements and the tax pack all go by it.
  Until it's said, they show both figures (they used the flat 27% unless a provisional estimate
  for that year said otherwise). Gross income over R20 million rules the table out. Saving a
  provisional estimate no longer answers the question. All estimates: your accountant confirms
  the tax.
- The statements' income tax item compares the tax booked with the estimate; nothing due on the
  SBC table is nothing to book; "Book the tax" is gone from a year agreed with your accountant (or
  with a later year agreed) or closed, where it changed nothing; a company on turnover tax isn't
  asked for income tax.
- The tax note: the SBC rates' effect on a line of its own when the tax booked is on that table,
  both years' company rates when they differ, and an assessed loss carried forward. Statements
  approved before stay approved.
- **Provisional tax paid** (IRP6): record it from the provisional tax screen (only for a business
  taxed on its own profit); it comes off what's owed to SARS for the year's income tax, the screen
  lists what's been paid and takes it off what's still to pay, and the tax pack keeps what was
  paid apart from the tax booked. Deleting a SARS payment is logged. A company file carries the SBC
  answers.
- The small business corporation tables back to 2021, 2023's medical scheme credits, and **VAT
  categories D** (six-monthly) and **E** (yearly). The dividends tax return named with its DTR02.
- From 1 March each year the checks fail until the new tax year's figures are in, and the home
  screen says when this version's SARS tables end before the tax year you're in.

## 1.7.1 (10 November 2026)

- zod 4 (4.6.7), the checker of everything the app's screens hand its books: the security update
  for [CVE-2023-54404](https://www.vulncheck.com/advisories/zod-uncontrolled-resource-consumption-via-array-validation)
  (from Shap 1.23.1). A refused entry still says "Required" or "Invalid" where a field has no words
  of its own, and an unknown accountant export is refused rather than failing.

## 1.7.0 (10 November 2026)

The financial statements checked against the IFRS for SMEs Accounting Standard, and a tax pack for
your accountant, from Shap 1.23.

- **The IFRS for SMEs check** (Shap's docs/IFRS.md, the same accounting code): interest paid and
  received on lines of their own in the statement of cash flows; assets you paid for personally,
  financed, or bought on a bill still unpaid at the year end left out of the cash flows and told in
  a note; the legal form and the edition of the standard in the general information; the revenue
  policy worded as the app books it; and **For your accountant to look at** with the checks: the
  year's income tax (with the app's estimate, booked with one tap), work in progress, invoices
  over a year overdue, leave pay owed.
- **The public interest score**: worked out from your books for a company or close corporation,
  with what it points to (an audit, an independent review, or a compilation), as an estimate.
- **Close corporations**: the statements carry the accounting officer's report (s62); upload it
  signed with the statements.
- **Tax pack** (Accounts → Export): the year's income statement, the income tax estimate and your
  provisional tax estimates, the VAT201s, payroll, dividends and the assets bought and sold, in
  one PDF to share with your accountant.
- Every figure the app works out for tax or the law says it's an estimate: OpenWorks IT aren't
  accountants, and the app isn't advice.
- The assessed loss brought forward is worked out year by year (a profit before a loss doesn't use
  it up), and a company's set-off is limited to the greater of R1 million and 80% of its taxable
  income (years ending on or after 31 March 2023); a trust's estimate leaves out what it gave its
  beneficiaries, up to the year's income.
- Uploading the signed compiler's report, and approving, failed in the app (the statements'
  fingerprint used something only a server has). Fixed, and statements uploaded on 1.6 stay signed
  after the update: a signed set is now fingerprinted by the books it came from.
- An asset's bill you paid personally, or that a supplier's credit note took off, isn't cash paid
  for it in the cash flows; subcontractors don't count as employees in the public interest score;
  a reviewed close corporation's accounting officer's report doesn't say no review was done.

## 1.6.0 (10 November 2026)

Sales at the counter and the annual financial statements, from Shap 1.22. Each is switched on in
setup, or in Settings → What you use.

- **Sales**: a Sales tab for selling over the counter. Pick items from a quick list, take the
  money into the till or the bank, and share the slip on WhatsApp or email. Each line keeps its
  VAT class (standard, zero-rated, export, exempt); if you're not registered for VAT you sell
  without it. Over R5 000, or with an export, the app asks for the customer (a full tax
  invoice). A sale can be made an invoice afterwards, and refunded: a credit note for what came
  back and the money paid out. Sales and refunds are never changed or deleted. (Stock records
  are full Shap's: Shap Pocket sells without keeping them.)
- **Financial statements** (Accounts → Financial statements): the year's statements drawn up from
  your books under the IFRS for SMEs Accounting Standard. Share them with your accountant, upload
  their signed compiler's report when it comes back, approve them, and the year is agreed and
  closed.
- **Where each account goes** on the statements (current or non-current and so on) is set on the
  account in Settings → Chart of accounts; the app sets it for every account already.
- A new kind of business in setup: **Shop, retail or trading**.
- **Goods returned** on an invoice: a credit note for what came back, the money paid back or
  taken off what's still owed.
- **Bills to pay**: a supplier's credit note on account is taken off one of their bills (it waits
  under Bills to pay until it is), so the bill shows what's really owed.
- Reports and the accountant's export up to a past day (a year end) start at that day's
  financial year, instead of refusing.

## 1.5.1 (9 November 2026)

Fixes from the first code scanning (CodeQL) of Shap Pocket, and from an independent review of
the books check (the same as Shap's 1.21.1).

- **The books check** no longer calls correct books wrong: a year agreed at your accountant's
  figures, a cost's VAT rounded the way the app allows, a year end changed after a year was
  agreed, and old tax invoices after deregistering for VAT all come out clean. Debtors, creditors
  and PAYE now agree to the cent or say so (journals you typed in are counted apart and shown),
  and an agreed year says if anything dated in it was added or changed after it was agreed.
- Splitting a cost never gives a part more VAT than its own amount can hold.
- The empty books load from the app's own file on iPhone too (its address reads differently there).
- Bug reports' steps are cleared of addresses and numbers by shared code (the same Shap uses).
- The app's build and publishing steps use GitHub's actions pinned to exact versions.

- The engine takes a query parameter called __proto__ or constructor as just a name.
- The database worker only loads the empty books from the app's own file, and only answers the
  app's own page.
- Tidying a company registration number no longer uses a pattern that slows down on a long run
  of spaces.

## 1.5.0 (9 November 2026)

- **Checks** in Settings → Checks & audit log: your books checked the way an accountant would.
  Everything balances; debtors, creditors, VAT and payroll agree with the invoices, bills, VAT201s
  and EMP201s behind them; agreed years are unchanged; tax invoices are complete; no invoice
  number is missing unexplained.
- **Every update is checked before release**: the tests (the accounting, VAT and payroll rules,
  security and privacy), known vulnerabilities in what the app is built from, and every outside
  address in the code on a privacy list.
- Bug reports no longer carry the names on buttons in lists, and blank email addresses and
  numbers in what they record.
- A date or number out of range is refused plainly instead of failing.

## 1.4.0 (9 November 2026)

- **Updates from Google Play, inside the app.** Shap Pocket asks Google Play whether there's a
  newer version. Play's own update sheet offers it (at most every three days), it downloads while
  you work, and Restart installs it. Until then, Home keeps a reminder with an Update button.
- The backup clip shows only in the computer version (the phone's backup screen is different).
- **One tap for payment terms.** On an invoice: due on receipt, in 7, 14 or 30 days, or at month
  end; on a quote: valid for 7, 14, 30 or 60 days. A tap sets the date and changes the wording in
  the terms to match (“Payment due within 30 days”). Changing the invoice date keeps the term.
  Settings (and setup) have the same choices for the usual terms.
- **Calmer how-it-works clips.** Re-recorded slower, a few steps each, with a caption above the
  screen saying what each step is.
- “1 cost”, not “1 costs”.

## 1.3.0 (9 November 2026)

- **Issued tax invoices are fixed.** Once a VAT vendor's invoice is issued, its items and
  prices, the client, the date, the number and the trading name can't change: SARS allows one
  tax invoice per supply. Correct one with a credit note, and a new invoice for anything extra.
  The due date, notes, terms and payment link can still change. Invoices from a business that
  isn't registered for VAT stay open to change, as before.
- **Clips full screen.** Tap a how-it-works clip to watch it over the whole screen. It plays once
  and goes small again by itself; tap anywhere to close it sooner.

## 1.2.0 (9 November 2026)

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

## 1.1.0 (9 November 2026)

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
- **No more notification permission.** The weekly backup reminder was a phone notification; it's
  gone, and the app no longer asks to send notifications. Home still reminds you when a backup is
  due.

## 1.0.1 (7 November 2026)

- **The anonymous usage note** (only if you said yes to it) is now also sent after an update and
  about once a month while the app is used, so OpenWorks can tell how many people still use Shap
  Pocket and how many have taken each update. It still holds no names, clients or figures: just
  the app, version, kind of business and which features are on. Switch it off any time in
  Settings.

## 1.0.0 (6 November 2026)

The first full release.

- **A loading screen.** Opening the books shows a bar with how far it’s got, and what it’s busy
  with (“Fetching the books off the shelf…”, “Counting the rands…”), so it never looks frozen.
  The very first open, when a new set of books is set up, walks through each step.
- **Feels like an app.** The screen no longer zooms in on a pinch or a double tap, and nothing
  slides sideways or leaves scroll bars behind. In an ordinary browser tab, zooming still works.

And a full review of the figures, the tax rules and the security, with what it found put right:

**Figures that came out wrong**

- **Bad debts:** writing off an invoice now claims the VAT in it back in the books, as the VAT201
  already did (field 17). Before, the whole amount went to bad debts, so the VAT account didn’t
  agree with the return and profit was understated by the VAT. Years already closed stay as they
  were.
- **The bank and bills:** a statement line is matched to the payment made on a supplier bill,
  never to the bill itself (that paid it twice). The match screen also offers payments recorded on
  bills and invoices, refunds and journals on that account.
- **Transfers:** the second side of a transfer between two of your accounts is ticked off against
  the journal already there, instead of moving the money twice.
- A payment recorded into another account and matched to a bank line now moves to the bank, and
  back again if you unmatch it.
- **EMP201 in parts:** paying a month’s PAYE, UIF and SDL in two goes now clears each tax in turn.
- **Dividends** are closed into retained earnings at each year end. Years already agreed keep the
  figures they had.
- A job marked finished or cancelled takes its costs to cost of sales on that day, not back on the
  dates they were spent.
- Each partner has their own “Personal” cost type, against their current account.

**A closed year stays closed**

- An agreed year can’t be changed or removed while it’s locked, and agreeing a year pins every
  account. Moving a cost type or an account to another account in the books, or changing an
  account’s type, is refused once a closed year has postings on it. A job finished in a closed
  year can’t be reopened.

**Tax**

- Retirement annuity cap R430 000 from the year to February 2027; PAYE taken off a salary comes
  off provisional tax; overtime and commission taxed with the salary, a bonus on top of earlier
  ones, no UIF on commission; the EMP201 month is the month pay was paid.
- Turnover tax counts half of what selling the business’s assets brought in, not an individual’s
  interest (new “Interest received” account); a micro business pays no dividends tax on its first
  R200 000 of dividends a year.
- VAT on assets: claimed on an asset bought straight from the bank, charged when one is sold
  (fields 1A and 4A), none on a motor car. A cost’s VAT can’t be more than its amount can hold.
- Older years use their own tax tables; due dates move back over public holidays; rounding matches
  the database exactly.

**Privacy and security**

- Each phone now has its own install id (every phone on a build had the same one, so the
  anonymous market rates counted them all as one business).
- On a computer, the web app no longer copies Home’s figures into the browser’s storage.
- Android backups of the books only go to an end-to-end encrypted Google backup (a phone with a
  screen lock) or a phone-to-phone transfer.
- A restored backup can’t make a stored file open as a page: anything that isn’t a photo or PDF is
  only downloaded.
- Slip photos can only be swapped for smaller ones in a closed year, and each swap is logged.

## 0.9.0 (internal testing)

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

## 0.8.0 (internal testing)

- **Anonymous prices, to help show what work typically costs.** Once a month, when the phone is
  online, Shap Pocket shares the middle price you charged last month for each of your trade's
  standard items (like "Install plug point"), from issued invoices: never your name, clients, the
  invoices, anything you typed or totals. OpenWorks' server keeps only national totals. Never for
  advertising or marketing. It's on unless you switch it off in Settings, and nothing is shared
  until you've been told: a note on Home, or during setup.

## 0.7.3 (internal testing)

- **Opens about seven times quicker.** Home appears straight away with what it showed last time
  (in our tests 0.4 seconds instead of about 3), while your books open underneath; the fresh
  figures replace it a moment later. The books also start opening before the first screen is
  drawn, instead of after.

## 0.7.2 (internal testing)

More from the security review shared with Shap:

- **A PNG logo is redrawn on the phone when you add it**, so a damaged one is refused straight
  away instead of leaving a quote or invoice that never finishes.
- **Imports have sensible limits** (cells, rows, clients in one file), so a crafted bank statement,
  client CSV or move-in file can't freeze the app.
- **Exports are safer to open in Excel:** text a spreadsheet could run as a formula is neutralised
  wherever Excel might start a new cell, with a comma or a semicolon as its separator.
- **A company file is checked as if typed into Settings.**

## 0.7.1 (internal testing)

From the security review shared with Shap:

- **Closed years are better protected:** once a year is locked, an asset's cost can no longer be
  changed (the same rule costs already follow), so a signed-off balance sheet can't shift.

## 0.7.0 (internal testing)

More of what a small business needs, each one a switch under Settings → What you use.

- **Credit notes:** take back part or all of an issued invoice (a return, a discount, a mistake),
  with their own numbers (CN0001…). Issued, a credit note comes off the invoice's balance and its
  VAT comes off the VAT return. Void it to undo.
- **Pro-forma invoices:** ask to be paid before the work starts. Their own numbers, “not a tax
  invoice” on the PDF, and turned into a real invoice once paid.
- **PayShap:** your ShapID printed on unpaid invoices and pro-formas, and in the message when
  you send one, so clients pay instantly from their banking app.
- **Payment reminders:** Home lists overdue invoices (part-paid ones too) with a Send button:
  the invoice and a friendly message to WhatsApp, email or SMS, noted on the invoice.
- **VAT201:** the return box by box for each period (category A, B or C), with the due date;
  Home reminds you when one is coming up.
- **Turnover tax:** for micro businesses registered for it, the tax estimate switches to
  turnover tax on SARS's 2026/27 table (up to R2.3 million), with the two interim payments.
- **Supplier bills:** costs you'll pay later, what's owed and when it's due, paid off from
  Bills to pay; Home shows bills due this week.
- **Travel logbook:** SARS's logbook (trips, odometer at the start and end of the tax year,
  business share), downloaded as a spreadsheet.
- **Time tracker:** a clock per job, an hourly rate on the job, and unbilled time onto an
  invoice in one tap.
- **SARS filing guides:** step by step through VAT201, provisional tax, ITR12, ITR14,
  EMP201, EMP501, turnover tax and dividends tax, with where each figure is in Shap. We're not
  accountants: only file yourself if you're lekker with some accounting.
- **For your accountant:** the books laid out for Sage 50 / Pastel, Xero, QuickBooks Online or
  Sage Accounting (journal, sales, purchases, payments, debtors), with a preview and the total
  to check after importing.
- **Wipe all data** (Settings → Your business): back up first, type the business's name, then
  the phone's lock.
- **Move in from another package** (Settings → Your business): the CSV exports of Sage
  Accounting, Xero, QuickBooks Online, Zoho Invoice / Books or Invoice Ninja. Clients, invoices
  with what's been paid (or the payments export, with its dates), quotes, items, bills and
  expenses, and the trial balance at your last year end as the opening balances, mapped to
  Shap's accounts. Each file is recognised by its columns; a preview shows what comes in before
  anything is saved, and it all goes in together or not at all.
- **Shap Pocket on a computer:** the same app, installable from Edge or Chrome on Windows (or
  any computer) at openworks.co.za/shap/app. It opens with no internet, keeps the books in the
  browser's storage for the app, and backs up with a Save dialog straight into your OneDrive or
  Google Drive folder. Backups move between the phone and the computer both ways.
- **The first-run questions cover the new parts:** do you charge by the hour (with your usual
  rate), drive for work (the travel logbook), get supplier bills on account, take payment up front
  (pro-formas), or come from another package (Move in opens straight after setup). The answers
  start from what's usual for your kind of business. Your PayShap ID, turnover tax and how often
  you file VAT can be set there too.
- **A usual hourly rate** (Settings → Invoicing & tax): for time with no job, and jobs without
  their own rate.
- The time tracker's clock is per person (ready for Shap's shared server).
- Fixed: changing an invoice that was already saved could fail with “Expected string”; dates
  from the books now reach the screens the way they do on Shap's server. Saving one Settings
  tab no longer undoes a switch flipped a moment before on another. Long lists no longer push
  screens wider than the phone.

## 0.6.0 (internal testing)

Fitted to your trade, and quicker.

- **Your kind of business runs through the app.** A designer sees “Logo design” and “Printing”,
  a salon “Cut and blow-dry” and “Colour, developer, foils”, not a builder's cement. Line types
  on quotes, invoices and their PDFs are named for the trade (Services / Products for a salon,
  Design / Print & production for a designer), and the cost types a trade needs are added
  (chair rent, salon stock, stock images, lens hire…) with the builder-only ones put away.
- **Usual items, one tap each:** what you charged before, with last time's price, then the
  common items for your trade.
- **New client straight from the quote or invoice**, and invoices with no name yet (a walk-in):
  add the name later.
- **Backups in the first-run questions:** why they matter, where to keep them (Google Drive,
  iCloud Drive, OneDrive, Dropbox, Proton Drive or email) with steps for your phone, and a
  reminder a week after each backup.
- **The Shap line** at the foot of quotes, invoices and payslips (switch it off in Settings →
  Sections).
- **Support Shap** in Settings: tell us what you need next (a new “Idea” kind of feedback).
- **Quicker:** screens show what they showed last time straight away and refresh underneath;
  the safety copy waits for a quiet moment instead of freezing the app; Home skips the parts
  you've switched off.

## 0.5.0 (internal testing)

First test version: Shap's books on the phone, for one person.

- The books run on the phone (PGlite), with no server and no account. Optional lock with Face
  ID, fingerprint or the phone's PIN.
- First-run questions: your business, what you do (switches off what you don't need), logo.
- Quotes and invoices sent through the share sheet; a shared quote counts as sent.
- Logo placer: drag, pinch and centre it in the same box it fills on the PDF.
- Backup to iCloud Drive, Google Drive, OneDrive or Proton Drive through the share sheet;
  restore from a file. A safety copy inside the app covers the phone clearing its storage.
- Sole proprietor or company; provisional tax estimate on SARS's tables; VAT threshold watch.
- Payroll (PAYE, UIF, SDL, payslips, EMP201) and dividends with dividends tax.
- Step-by-step first opening: company or sole proprietor, what you do, employees, how your
  work runs, logo, invoice details, formal or casual.
- Feedback button; card payment link (Yoco) on invoices.
- From Shap 1.8.0: costs and slips, bank statement import and matching, duplicates, monthly
  cost watch, jobs, workers, assets (including intangibles), year end, exports.
