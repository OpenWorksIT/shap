# Changelog

What changed in each version of Shap, newest first. Settings → Updates & backups shows the
entries newer than the version you're running before you update.

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
