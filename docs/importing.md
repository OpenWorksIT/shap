# Importing a project tracker

Shap reads the Excel tracker it grew out of. Upload it under **Settings → Import tracker**, or run
`npm run import -- tracker.xlsx` on the server. You see a preview first, and nothing changes until
you press **Import**. The import runs as one transaction, so it either all goes in or none of it
does.

Columns are found by their **headings**, so the order of columns doesn't matter and extra columns
are ignored.

## What goes where

| Sheet | Columns used | Becomes |
|---|---|---|
| **Per Project** | `#`, `Project`, `Client` | A job with its number, and a client (named after its code until you import client details) |
| | `Q Labour`, `Q Parts`, `Q Demo` | The job's estimate (used until a quote is accepted in Shap) |
| | `Invoice #`, `Date`, `I Labour`, `I Parts`, `I Demo`, `I Total` | An issued invoice with a labour, materials and demo line (plus a balancing line if `I Total` differs) |
| | `Received` | A payment on that invoice, into the default receiving account, dated the invoice date |
| | `C Demo` | A *Demo* cost on the job |
| | `C Labour`, `C Parts` | Not imported: used to check the import |
| | `To Charge` (formula like `=L12*1.35`) | Your mark-up (35%) for *Charge job costs* |
| **Costs** | `Date`, `Name`, `Cost`, `Supplier`, `Type`, `Account`, `Project` | A cost. `Type` picks the cost type, `Account` the payment source, `Project` the job |
| | `Personal` = `Y` | Paid personally (owner's loan), when `Account` is blank |
| | `Personal` = a job name (e.g. *Home roof*) | A personal expense against the owner's loan, not a company job |
| **Wages List** | `Date`, `Worker`, `Wage`, `Allowance`, `Total` | A labour day on the job in `Project` (or in the Allocate list if there's no job) |
| | `Paid` | A wage payment, from *Cash* (or *Paid personally* if `Personal` = `Y`) |
| | `Worker` = `Casual` with a name in `Casual?` | A casual worker of that name |
| | `Project` = `To savings` / `From savings` | Savings held for the worker (amount in `Casual?`) |
| **Trade Statement** | `Invoiced`, `Parts Cost`, `Labour Cost` by month | Not imported: used to check the import |
| **Trial Balance …** | `As of <date>`, bank, loan, share capital | One journal agreeing bank, the owner's loan and share capital to that trial balance |

Workers' day rates and allowances are taken from what they were usually paid recently, not from
the last row. Anyone who hasn't worked in the last 90 days of the tracker is imported as not
active: they're kept, just off the crew list.

### Payment sources

| `Account` value | Becomes | Posts to |
|---|---|---|
| e.g. `FNB CS` (anything with *CS* or *business*) | Business bank | Bank |
| Cards and accounts in the owner's name (e.g. `Owner CC`, `Owner savings`) | A source of that name | Owner's loan account |
| Blank | Nothing: the cost is *not captured yet* | *Costs not yet matched to a payment* (a holding account) until you say what paid it |

A blank `Account` means you hadn't captured how it was paid, so Shap doesn't guess. **Costs → Not
captured yet** lists them; tick the ones paid the same way and choose the account or card. Until
then they sit in a holding account, so your bank and loan balances leave them out.

You can change any of these afterwards under **Settings → Lists**. Because the ledger is built
live, changing where a source posts restates every cost paid from it.

## The checks

After importing, Shap reports:

- **Per Project.** Every job's labour and parts compared with `C Labour` and `C Parts`, within a
  rand of rounding (Excel keeps fractions of a cent).
- **Trade Statement.** Invoiced, parts and labour month by month, and in total. Invoicing agrees
  exactly. Parts and labour can move between months where a slip or a day is dated after the
  job's invoice: the pivot puts it in the invoice month, while Shap counts it in the month it
  happened, or holds it in work in progress until the next invoice.
- **Trial balance.** The journal it posted, and anything left in *Suspense* (for example
  work in progress at year end, which a tracker trial balance usually doesn't carry). Once you
  enter the accountant's figures for that year (**Accounts → Year end**), they replace this journal.

## After the import

1. **Settings → Company**: name, registration and VAT numbers, and your **trading names**: each
   has its own logo, colour, contacts and bank details, and every job, client, quote and invoice
   can go out under any of them. Numbering and the books are shared. A company file (see
   [deployment](deployment.md#company-file)) sets all of this up in one go.
2. **Clients → Import details**: an Invoice Ninja client export (or any CSV with a *Name* column).
   Tracker clients are named by code (`Naidoo001`), so Shap suggests which client each row is from
   the code, the job names and the street address, and you check the list before anything changes.
   Jobs with no client can be linked in the same step.
3. **Workers → Allocate**: put labour days that had no job onto a job or a type of general work.
4. **Accounts → Balance checks**: enter today's bank balance and your loan balance. The tracker
   doesn't record money moving between the bank and your own accounts (card repayments, the
   company paying you back), so the books will differ. One tap posts the difference as an
   adjustment journal.
5. **Accounts → Year end**: type in the accountant's figures from the annual financial statements.
   Shap posts one adjustment per account on the last day of that year, so the statements match and
   the next year opens from the agreed balances; the year is locked. Anything that doesn't tie up
   shows in *Suspense*.
6. **Accounts → Bank statements**: import each account's statement (CSV from online banking).
   Matches go in by themselves where they're certain; tick through the rest. This is also the
   quickest way to clear *costs not captured yet*: matching a cost to the statement records how
   it was paid.
7. **Accounts → Provisional tax**: this year to date, projected to twelve months, against last
   year, with the tax on the small business corporation table. Change any projected figure, then
   save or print it for the IRP6.

Importing again later needs **Replace what's there**, which deletes jobs, people, costs and
documents first. Settings, users and your lists are kept.
