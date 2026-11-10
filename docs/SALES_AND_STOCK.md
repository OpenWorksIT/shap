# Sales and inventory

Switched on in setup ("Do you do sales?", then "Do you plan to keep inventory records in Shap?")
or later under **Settings → What you use → Selling**. Sales without inventory is for a business
that keeps its handful of stock in a spreadsheet; inventory needs sales (switching it on switches
sales on). Shap Pocket has sales only: stock records are full Shap's.

Nothing here is ever changed or deleted once made: a sale, a refund, a stock movement, a supplier
invoice for stock, a claim, a stock take. A mistake is put right with the next record (a refund, a
return, a count), so the history reads straight down. The database refuses changes too (triggers
in `apps/server/migrations/039_sales_stock.sql`), and the books audit checks those safeguards are
in place.

## Sales (the Sales tab)

**Sell**: tap items from the quick list (search by name or code; with inventory, filter what's in
stock or not: anything can be sold either way), or add a line that isn't on the list. Each line
keeps its VAT class: standard, zero-rated, export or exempt. Prices are as on the shelf, VAT
included. Take the money (cash into the till, card or EFT into the bank) and hand over the slip.

- A walk-in needs no details: the slip is the **abridged tax invoice** (up to R5 000, VAT Act
  s20(5)). Over R5 000, or with anything exported, SARS wants a **full tax invoice** (s20(4)):
  the sale asks for the customer, and becomes an invoice paid at once.
  https://www.sars.gov.za/businesses-and-employers/tax-invoices/
- A business that isn't registered for VAT sells without VAT: the classes are ignored and the
  slip isn't a tax invoice.
- A sale posts like an invoice and its payment together: revenue and output VAT on its date
  (the VAT201 for that period), the money in the till or bank, debtors untouched. Stocked items
  go out of stock at their weighted average cost, into cost of sales.

**Make it an invoice** (afterwards, for a regular or a business customer): the customer is
chosen, the sale gets the next invoice number (keeping its sale number), and every item, price
and VAT class stays as sold. It stays paid.

**Refund**: choose what came back. A credit note is issued for it at the prices and VAT classes it
was sold at (with the reason on it, s21), and the money is paid out of the till or bank. Goods in
good order go back into stock at the cost they went out at; damaged ones don't (their cost stays
in cost of sales). Never more can come back than was sold, nor more money than was paid. A
walk-in's credit note is short like its slip; an invoice's carries the customer's details.

**Goods returned on an invoice** (the invoice's page → Goods returned): the same, for an invoice
from Quotes & invoices. While the invoice is still owed, what comes back is taken off what's
owed instead of paid out (never more than is owed).

## Inventory (the Inventory tab, full Shap)

Stock is measured at **weighted average cost** (IFRS for SMEs 13.18; LIFO isn't allowed), at the
lower of cost and selling price less costs to sell (13.4, 27.2). Each item's quantity and value
change only through movements, each with its date, who, why and what caused it (a sale, a
refund, an invoice, a supplier invoice, a return, a count). Open an item to see its whole story.

| What happens | Stock | The books |
| --- | --- | --- |
| Supplier invoice (paid, or a bill to pay) | in, at the invoice's cost per unit (VAT that can't be claimed included, IFRS for SMEs 13.6) | a cost on **Stock purchases**: its VAT claimed like any cost; the cost to a clearing account, emptied into **Inventory** as each line arrives |
| Short supplied (invoiced, not delivered) | nothing for what didn't arrive | that part becomes a **claim on the supplier** (Dr Supplier claims, Cr clearing) |
| Stock already on hand (an item's first movement) | in, at its cost | out of cost of sales (bought earlier, in costs already), or against the opening balances (moved in) |
| Sale, or invoice issued | out, at average cost | Dr Cost of sales – goods, Cr Inventory |
| Invoice voided | back in, at what it went out at, on the invoice's date | reversed (the voided invoice never happened) |
| Refund, back in good order | back in, at what it went out at | Dr Inventory, Cr Cost of sales |
| Sent back to the supplier (bad order, wrong item) | out, at what the supplier charged (or average cost) | a claim on the supplier |
| Supplier's credit note | | a negative cost on Stock purchases (VAT back), settling the claims chosen; anything beyond them is a discount on stock bought (Cr Cost of sales). On account, it's taken off one of their bills (Bills to pay shows what's left of it until it is) |
| Claim the supplier won't settle | | written off to **Stock losses** |
| Stock take | corrected to what was counted, the reason kept | the difference at average cost to Stock losses (or a gain) |
| Written down (Inventory → Valuation, for stock carried above its selling price) | its value down to the selling price before VAT (IFRS for SMEs 13.19, 27.2), quantity unchanged; dated on or after the item last moved (what's on hand then; earlier is a journal) | the difference to Stock losses |

**Selling what isn't in stock** takes the quantity below nothing (it's costed at the item's last
cost). When stock next arrives, the item is revalued: its value becomes what's on hand at the new
cost, and the difference goes to cost of sales. A stock take puts it right too. The Inventory tab
flags anything below nothing.

A stock take is dated: movements after that date stay as they are, and an item that moved after
the date can't be counted at it (count it as at today). Once counted, nothing can be dated before
the count for that item (a late supplier invoice is dated on or after it; an invoice from before
it is taken back with a credit note, not voided).

A business not registered for VAT types each purchase price as paid, VAT included: none of it can
be claimed, so it's all cost. Items not typed in aren't part of the
count. The count itself is kept, also where nothing differed: who counted, when, what Shap had.

## What the books audit checks (Sales and Stock)

- every sale has its payment, for exactly its total, and every refund its credit note;
- the credit clearing account is empty; sale numbers run without gaps;
- the **Inventory** account equals the sum of the movements and the items' values, and each item
  equals the sum of its own movements; no item has value with nothing on hand (or the reverse);
- **Stock purchases** clearing is empty, and its purchases' lines add up to what was invoiced;
- the **Supplier claims** account equals what's still owed back on the claims; old claims are
  flagged;
- every stocked line on an issued invoice, sale or credit note moved stock by its quantity;
- warnings: stock below nothing; an item carried above its selling price (write it down at a
  count, IFRS for SMEs 27.2); stocked items not counted in the last year; the opening stock
  account not cleared into the opening balances;
- the safeguards that stop stock records and refunds being changed are in place.
