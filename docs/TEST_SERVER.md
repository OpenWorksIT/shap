# The test server

A test server is a Shap for trying Shap out with made-up books: an accountant checking Shap's
figures, a developer testing an update, or anyone seeing how Shap handles a kind of business they
don't run. Set it up as any kind of business, fill the books with made-up data for that setup,
check the figures, then wipe it all and set it up as something else.

It's switched on on the server (`TEST_SERVER=true`), never from the app. On every other Shap the
filling and wiping described here refuse (`not_test_server`): a real business's books are never
filled with made-up data or wiped from here. (Settings → Wipe all data, for a real business's own
books, is unchanged.)

## Setting one up

On a server that runs Shap with Docker Compose (docs/deployment.md), as another company:

```bash
cd /opt/shap/deploy/vps
sudo ./add-company.sh test shaptest.yourcompany.co.za --test-server   # point the DNS at the VPS first
sudo docker compose exec app-test node apps/server/dist/db/create-owner.js \
  --email you@yourcompany.co.za --name "Your Name" --company "Test Business (made up)"
```

`--test-server` adds two lines to `companies/test.env`: `TEST_SERVER=true`, and
`COLLECTOR_URL=off`. A test server sends nothing to OpenWorks either way (no anonymous prices,
usage notes or feedback: feedback stays on the test server, under Settings → Feedback). It also
keeps the test server to one CPU and 1 GB of memory, so filling its books doesn't slow the real
companies on the server. Leave `SMTP_URL` unset: the clients are made up, and without it Shap
only logs the emails it would have sent. The test server shares the app with the other companies on
the server, so an update reaches it at the same time.

Whoever is going to fill and wipe the books needs an **Owner** sign-in on the test server
(Settings → People who sign in). Wiping keeps everyone's sign-ins and two-factor set-up.

## Using it

1. **Set up**: the first-run questions, as for a real business: the kind of business, the trade,
   VAT, quotes and jobs, employees, casual workers, counter sales and stock, the extras.
2. **Fill**: Home → *Fill with made-up data*. Shap fills the last full financial year and this one
   to date, through its own API as the owner would have captured it: a minute or two (a busy shop
   takes longest). Anyone else saving meanwhile is asked to wait.
3. **Check the figures**: everything works as on a real Shap: reports, VAT201s, EMP201s and the
   EMP501, provisional tax, the financial statements, the books audit, the accountant's export.
4. **Wipe**: Home → *Wipe and start again* (type WIPE and your password). The books go back to
   the first-run questions; sign-ins, two-factor and the audit log stay.

A banner on every screen says it's a test server.

## What the filling makes

What the setup switches on decides what's made, as a business like that would have:

| Setup | Made up |
|---|---|
| Every business | 24 clients (a few VAT vendors, with VAT numbers; businesses marked "made up"), money put in by the owners at the start, a vehicle, computer or equipment bought on day four (depreciated; the bakkie with a residual value), monthly overheads (rent for a trade with premises, phone, insurance, bookkeeping, bank charges, software, advertising, now and then a client lunch, small tools, stationery), credit notes for discounts, a bad debt written off, most costs with a made-up supplier's slip (a PDF that says it's made up; about one in twelve has none, so the books audit's "VAT without a slip" has something to show) |
| Quotes → jobs → invoices | Jobs with quotes (most accepted, some declined, some still waiting), materials bought onto the job, the invoice when the job's done |
| Quotes → invoices / just invoices | Quotes turned into invoices / invoices straight away |
| Clients paying | On time, late, in two parts, or (rarely) never |
| Not registered for VAT, or on turnover tax | Trade kept to about 70% of the compulsory VAT registration line (R1 million before 1 April 2026, R2.3 million after) and of the turnover tax limit for the year, a twelfth a month, spread over the month; a smaller place to rent and one employee |
| VAT | Each period's VAT201 paid on its due date (a refund received about three weeks after), by journal from the bank, from the first period the books reach |
| Payroll | One to three employees (a company's or Inc.'s director on a salary too), a pay run on the 25th, a December bonus, overtime now and then, someone leaving at the end of the tenth month and someone new starting the next; each EMP201 paid by the 7th. Without SDL, the payroll stays under R500 000 a year; no medical aid through the payroll |
| Casual workers | Two of them, each in two or three days a week (on a job when one is running), paid each Friday. Shap's casual labour has no PAYE or UIF: someone working more than 24 hours a month contributes to UIF, so check how your business pays its helpers |
| Counter sales | Every trading day (Saturdays too for a shop, salon or café), cash into the till and card into the bank, the till banked each Monday, refunds now and then (from the till when it has the cash); a shop's account customers on full tax invoices. Zero-rated goods go to walk-ins only up to R50 (VAT Act s20(5), (6)) |
| Stock | Items bought in, reordered when low, counted each quarter (and at the year end) with a few missing. A business not registered for VAT pays VAT on its stock as part of its cost |
| Sales without stock in Shap | Goods for resale bought as a cost each week (zero-rated foods on a cost of their own) |
| Supplier bills | Materials and stock bought on account, paid when due |
| Time tracker | The hours on the time tracker, put onto the invoices |
| Travel logbook | A panel van too, for a trade that doesn't already have a bakkie; trips there and back on about half the working days; the odometer by SARS's tax year (March to February), moving by the trips. Private trips only for a sole proprietor or partners, under 5% of the kilometres |
| Pro-forma invoices | Some jobs paid up front: the pro-forma, then the tax invoice when the money comes in (VAT Act s9(1)). Its revenue is then in the books before the work is done |
| Sole proprietor, partnership | Drawings each month; the owners' own provisional tax (and turnover tax's two interim payments, TT02, on turnover tax) paid from the business as drawings. (A company on turnover tax makes no TT02 payments: Shap has no payment of its own for them yet) |
| Partnership | Two partners (60/40) with capital accounts |
| Company, CC, co-op, Inc., trust, NPC not approved as a PBO (not on turnover tax) | Provisional tax (IRP6) six months in and at the year end, for what Shap's own provisional tax screen works out (the year so far projected to twelve months; half at six months, the rest less what was paid), rounded down to R100 |
| Company, CC, Inc. | A dividend (a CC's distribution) about three months after the year end, out of last year's profit after tax, with dividends tax paid by the end of the next month |
| Co-op | Five members, each with a R1 000 share; the distribution shared equally between them (simplified: a co-op shares its surplus by how much each member did business with it, Co-operatives Act s44) |
| Trust | A beneficiary who is also a trustee, and another trustee; a distribution of the year's income to the beneficiary at the year end (taxed in their hands, s25B) |
| Any business | When the bank would go below R10 000, the owners lend the business what it needs (a sole proprietor puts in more capital): an overdraft would be trading on credit nobody arranged |

Nothing at the year end is done for you: the years aren't agreed, the tax isn't booked, the
partners' profit isn't shared and the statements aren't compiled. Also left for you, as in a real
business: the stock count when stock isn't kept in Shap, leave pay owed, reviewing work in
progress, a co-op's indivisible reserve (Co-operatives Act s46), and the going-concern assessment.
The statements' checks point at each. A month end that locks by itself is held off while the books
fill, then set back.

The dividends and distributions are a rule of thumb (at most half the profit after tax, never out
of the bank's last R30 000), not the solvency and liquidity test (Companies Act s4, s46; CC Act
s51), which is the owners' to do. The statements name the made-up owners as the directors
(members, trustees, partners).

The same setup always gets the same books: each month's activity comes from a random generator
seeded with the setup's answers and the month, so a month that has ended always looks the same,
whichever day of the financial year you fill. (Filled after the year end, the filling starts a
year later, and the months come out differently. Today's month grows as the days pass.)

Every name, number and address is made up: streets like "Test Street" in "Fictional Town",
businesses marked "(made up)", emails at example.com, phone numbers starting 000, and ID, tax and
VAT numbers that only pass their check digits (one may, by chance, be someone's real number, as
with any made-up test data). Prices are a rough idea of each trade's, not anyone's actual rates.
The filling's own figures (drawings, dividends, how much trade) are rough rules of thumb so the
books look lived in, not tax or accounting advice; the tax it pays is what Shap estimates, and
Shap's estimates are estimates. Shap is free software from OpenWorks IT, who are not accountants,
tax practitioners or auditors: check anything you'd rely on with your own accountant.

## Things to know

- Filling refuses books that already have data in them (clients, documents, costs, journals,
  projects, people, items, assets, trips, time, bank statements, year ends or tax estimates;
  partners added after setup are fine): wipe first.
- If the server restarts while the books fill, the filling stops part way: wipe and fill again.
  (The filling's own sign-in is removed and month end set back when the server starts.)
- Every filling and wiping is in the audit log, with who did it.
- The code: `apps/server/src/modules/test-server.ts` (the routes), `apps/server/src/testdata/`
  (the generator, the trades it draws on, the slips), `apps/web/src/components/TestServer.tsx`
  (the banner and Home's panel). The tests (`test/test-server.test.ts`) fill one of each kind of
  business and check each passes the books audit.
