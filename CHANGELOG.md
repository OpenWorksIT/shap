# Changelog

What changed in each version of Shap Pocket, newest first.

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
- Fixed: changing an invoice that was already saved could fail with “Expected string”; dates
  from the books now reach the screens the way they do on Shap's server. Saving one Settings
  tab no longer undoes a switch flipped a moment before on another.

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
