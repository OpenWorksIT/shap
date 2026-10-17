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
| Blank | *Not recorded (tracker)* | Bank, or the owner's loan if you choose so at import |

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
  work in progress at year end, which a tracker trial balance usually doesn't carry).

## After the import

1. **Settings → Company**: name, registration and VAT numbers, banking details, logo.
2. **Clients → Import details**: an Invoice Ninja client export (or any CSV with a *Name* column)
   fills in names, emails and addresses, matched on the client number or name.
3. **Workers → Allocate**: put labour days that had no job onto a job or a type of general work.
4. **Accounts → Balance checks**: enter today's bank balance and your loan balance. The tracker
   doesn't record money moving between the bank and your own accounts (card repayments, the
   company paying you back), so the books will differ. One tap posts the difference as an
   adjustment journal.
5. Once your accountant has signed off a year, set **Books closed up to** under
   *Invoicing & books*.

Importing again later needs **Replace what's there**, which deletes jobs, people, costs and
documents first. Settings, users and your lists are kept.
