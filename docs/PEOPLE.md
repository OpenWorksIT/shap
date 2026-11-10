# People who sign in, and what each may do

**Settings → People who sign in.** Everyone signs in as themselves, and each person is one of these:

- **Owner**: everything, including the settings and the people who sign in.
- **Accountant (read only)**: sees and exports everything, changes nothing, and compiles the
  financial statements (docs/STATEMENTS.md).
- **Staff**: does only the jobs ticked for them.

## Profiles

A profile is the jobs one kind of staff does, built once: **Teller**, **Admin** and **Site staff**
come with Shap, and **New profile** adds more (a bookkeeper, a storeman). Each person on staff gets a
profile, and **Adjust for this person** changes it for them alone (a teller who may also refund, an
admin who doesn't see payroll), or **Only what I tick** for someone without a profile.

When a profile changes, everyone on it has the change at once (their next tap), except what was
changed for them: Shap keeps a person's changes as what's ticked beyond their profile and what's
taken off it, so those stay as they were. A profile can only be removed once nobody is on it.

## The jobs

The jobs are listed under the headings of the parts of Shap they belong to. A heading (or a job)
that belongs to a part that's switched off isn't shown, and what was ticked there is kept for when
it's back on. Ticking a heading ticks everything under it. Some jobs need another (refunding needs
the sales to be seen): ticking one ticks the other.

| Heading | Job | Needs |
| --- | --- | --- |
| Selling | Sell at the counter (their own sales and slips, and making a sale an invoice) | |
| | Refund | See all sales and takings |
| | See all sales and takings | |
| | Change items and prices | |
| Inventory | See stock (quantities and each item's history) | |
| | See what stock cost (cost prices, values, the valuation) | See stock |
| | Supplier invoices, returns and credits | See what stock cost |
| | Count stock | See stock |
| Quotes & invoices | See quotes and invoices | |
| | Make and change them (draft, issue, send, convert, credit notes, monthly invoices, goods back) | See them |
| | Record what's paid on them (payments received, write-offs) | See them |
| | Add and change clients | |
| Jobs | See jobs (and their parts lists, without the money) | |
| | See what jobs make | See jobs |
| | Add and change jobs and their plans (a quote from the plan also needs Make and change quotes) | See what jobs make |
| | Track time on jobs: their own time (the owner's, everyone's), with the billing rate only with See what jobs make or Make and change invoices; time onto an invoice also needs Make and change invoices | See jobs |
| Casual workers | Log days worked (at each worker's rate; their own entries for a day) | |
| | See days worked and wages | |
| | Workers, rates and wages paid | See days worked and wages |
| Costs & bills | Capture slips (no VAT claimed, no bills; their own for a day) | |
| | See all costs (and the slips on them) | |
| | Capture and change any cost (supplier invoices with VAT, bills, splitting, merging, tidying) | See all costs |
| | Pay bills | See all costs |
| | Log trips in the travel logbook | |
| Payroll | See payroll and payslips | |
| | Run payroll (employees, pay runs, SARS payments) | See payroll |
| Accounts & reports | Reports, VAT201 and the ledger (every report and the books, read only, and the statements; the ledger names each worker's days and wages) | See days worked and wages |
| | Bank statements (bring them in, tick off what's captured, and capture what isn't: costs, payments received) | Reports, Capture and change any cost, Record what's paid |
| | Journals, assets and balance checks | Reports |

**Always the owner's**: the settings, the people who sign in and their profiles, the year end, tax
estimates, dividends and profit shares, sending, approving and reopening the financial
statements, moving in from another package, backups and the system. The audit log is the owner's
and the accountant's.

The profiles Shap starts with:

- **Teller**: sell at the counter, see stock.
- **Admin**: quotes and invoices (make, change, record what's paid), clients, any cost and supplier
  invoices with VAT, pay bills, supplier invoices for stock, the reports, bank statements, all
  sales, days worked and wages.
- **Site staff**: log days worked, capture slips, see jobs (what "site capture" was before 1.23).

## What staff see

The menu shows only the screens someone's jobs open, and the server refuses everything else (each
route says which jobs open it: `requireAccess` in `apps/server/src`). Staff who don't read the
reports see a home of their own (their jobs, one tap away), the company's names and pickers but not
its bank details, numbering or chart of accounts, and only the files they uploaded (or the slips on
the costs, if they see all costs). Someone selling without "See all sales and takings" sees only
their own sales and today's takings from them. Without "See what stock cost", stock is in
quantities only. A job (its client, site address, notes and parts) takes "See jobs"; logging days,
capturing slips or invoicing against one gives the open jobs to pick by name. Time on jobs is
each person's own. Without "See payroll", the tax pack and the books audit leave employees'
names and pay out.

## How it's checked

`apps/server/test/access.test.ts` tries every route for every job: each job (with what it needs)
opens exactly the routes that name it and nothing else, and someone with nothing ticked gets
through no door at all. The penetration test (`deploy/test/pentest.mjs`) signs in as site staff and
as a teller from the demo company and tries every route over HTTP.
