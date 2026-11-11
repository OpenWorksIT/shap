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
`COLLECTOR_URL=off` so that nothing goes from it to OpenWorks (feedback stays on the test server,
under Settings → Feedback). Leave `SMTP_URL` unset: the clients are made up, and without it Shap
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
4. **Wipe**: Home → *Wipe and start again* (type WIPE). The books go back to the first-run
   questions; sign-ins, two-factor and the audit log stay.

A banner on every screen says it's a test server.

## What the filling makes

What the setup switches on decides what's made, as a business like that would have:

| Setup | Made up |
|---|---|
| Every business | 24 clients (a few VAT vendors, with VAT numbers), money put in by the owners at the start, a vehicle, computer or equipment bought on day four (depreciated), monthly overheads (rent for a trade with premises, phone, insurance, bookkeeping, bank charges, software, advertising, now and then a client lunch, small tools, stationery), credit notes for discounts, a bad debt written off, most costs with a made-up supplier's slip (a PDF that says it's made up) |
| Quotes → jobs → invoices | Jobs with quotes (most accepted, some declined, some still waiting), materials bought onto the job, the invoice when the job's done |
| Quotes → invoices / just invoices | Quotes turned into invoices / invoices straight away |
| Clients paying | On time, late, in two parts, or (rarely) never |
| VAT | Each period's VAT201 paid (or the refund received) on its due date, by journal from the bank |
| Payroll | Two or three employees (a company's director on a salary too), a pay run on the 25th, a December bonus, overtime now and then, someone leaving and someone joining; each EMP201 paid by the 7th |
| Casual workers | Days worked (on a job when one is running), paid each Friday |
| Counter sales | Every trading day (Saturdays too for a shop, salon or café), cash into the till and card into the bank, the till banked each Monday, refunds now and then; a shop's account customers on full tax invoices. Zero-rated goods go to walk-ins only up to R50 (VAT Act s20(5)) |
| Stock | Items bought in, reordered when low, counted each quarter with a few missing |
| Sales without stock in Shap | Goods for resale bought as a cost each week |
| Supplier bills | Materials and stock bought on account, paid when due |
| Time tracker | The hours on the time tracker, put onto the invoices |
| Travel logbook | Trips most working days, the vehicle's odometer each year |
| Pro-forma invoices | Some jobs paid up front: the pro-forma, then the tax invoice when the money comes in |
| Sole proprietor, partnership | Drawings each month; provisional tax paid from the business is the owner's (drawings) |
| Partnership | Two partners (60/40) with capital accounts. The year's profit isn't shared: that's the year end's, for you to do |
| Company, CC, co-op, Inc., trust, NPC not approved as a PBO | Provisional tax (IRP6) six months in and at the year end, on the year so far, rounded down |
| Company, CC, co-op, Inc. | A dividend (a distribution) three months after the year end, out of last year's profit, with dividends tax paid by the end of the next month |
| Trust | A distribution of the year's income to a beneficiary at the year end |

Nothing at the year end is done for you: the years aren't agreed, the tax isn't booked, the
partners' profit isn't shared and the statements aren't compiled. That's what the test server is
for. A month end that locks by itself is held off while the books fill, then set back.

The same setup always gets the same books: each month's activity comes from a random generator
seeded with the setup's answers and the month, so a month that has ended always looks the same.
(Today's month grows as the days pass.)

Every name, number and address is made up: emails are at example.com, phone numbers start 000, and
ID, tax and VAT numbers only pass their check digits (one may, by chance, be someone's real
number, as with any made-up test data). Prices are a rough idea of each trade's, not anyone's
actual rates. The filling's own figures (provisional tax, dividends, drawings) are rough rules of
thumb so the books look lived in, not tax advice.

## Things to know

- Filling refuses books that already have data in them (clients, documents, costs, journals,
  people, items, assets or trips): wipe first.
- If the server restarts while the books fill, the filling stops part way: wipe and fill again.
- Every filling and wiping is in the audit log, with who did it.
- The code: `apps/server/src/modules/test-server.ts` (the routes), `apps/server/src/testdata/`
  (the generator, the trades it draws on, the slips), `apps/web/src/components/TestServer.tsx`
  (the banner and Home's panel). The tests (`test/test-server.test.ts`) fill one of each kind of
  business and check each passes the books audit.
