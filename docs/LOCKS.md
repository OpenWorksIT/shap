# Locks: month end, VAT periods and closed years

Once a period is closed, nothing dated in it can change: no sale, invoice, cost, payment, journal
or stock movement, whoever tries (the owner too). That's what keeps the takings, the VAT returns,
the bank and the accountant's figures as they were checked. Shap keeps one lock date: everything
on or before it is closed.

**Who**: closing and reopening is a task in **Settings → People who sign in**, "Close and reopen
months and years" (with the reports). The owner always may. The accountant reads the locks but
doesn't change them.

## A business that sells: month end

With Sales switched on, each month is closed (setup asks how; change it under **Accounts → Month
end & locks**):

- **By hand**: the screen shows each month's sales, refunds, other invoices, costs and the bank
  lines not yet ticked off; check it over and **Close** it. From the day you choose (1 to 28) of the
  next month, Home reminds you while last month is still open.
- **By itself**: each month locks itself on the day you choose of the next month (the 7th: the
  first week to catch up), whether or not it's been checked. You can still close it earlier.
  Each one is in the audit log, by "month end, by itself". The month locks before the first change
  made on or after its day (a look at the books doesn't lock it; the screens show it as locked). It
  locks once: a month reopened after its day stays open until the next month's day, which closes
  both. A year end locks with its last month: a journal for the year (the tax, the accountant's
  adjustments) after that needs a reopen.

## A VAT vendor that doesn't sell: each VAT period

Registered for VAT without Sales, each VAT period is closed the same way (setup asks how; change it
under **Accounts → Locks**): **by hand**, with Home reminding you from the day you choose of the
month after the period ends while it's still open; or **by itself** on that day, whether or not it's
been checked ("VAT period end, by itself" in the audit log). Choose a day before the VAT201 is due
(the last business day of that month on eFiling), so the return is worked out from closed books.
The screen shows each VAT period's invoices, costs and the bank lines not yet ticked off. A VAT
vendor that sells closes each month instead (its VAT periods are made of months).

## Any other business: the year

The year is closed once the accountant has signed it off: under Accounts → Locks, or with the year
end ("lock the books"), or when the financial statements are approved.

## Putting something right in a closed period

Someone who may close and reopen **reopens** it from a month (or year): that month and everything
after it opens again (there's one lock date). They say why; the reason, who and when are kept in the
audit log, and Home shows the books are reopened (who and why only to those who may lock, the
owner and the accountant). Put it right, then **Lock it again** (back to where it was).

- **VAT**: a VAT period that has ended may have its VAT201 filed. Locks says which ended VAT
  periods a reopen opens. More output tax, or less input tax, in a filed period means a revised
  VAT201 (your accountant's); SARS doesn't take more input tax by revising a past period: a supplier
  invoice that came in late is claimed in the current one, so capture it dated in an open period
  rather than reopening. Sources: docs/SARS.md.

- A year whose financial statements were approved stays closed until the statements are reopened
  (Accounts → Financial statements, with the reason).
- Reopened approved statements go back to a draft; the set that was signed is kept as it was,
  with its signed PDF and why it was reopened (Accounts → Financial statements).
- A year agreed with the accountant keeps its agreed figures whatever's posted into it after; the
  difference goes to suspense for them to look at (docs/STATEMENTS.md).

## What else moves the lock, and what gets past it

The lock date moves forward also when the year end is locked (Year end), the financial statements
are approved, a company file or a move-in brings a closed year in, and month end locks a month by
itself (or a VAT period by itself): each is in the audit log. Nothing moves it back except a reopen.

On purpose, past a lock: agreeing a closed year with the accountant the first time (how a closed
year gets their figures); matching a captured cost to a bank line inside an agreed year (the
agreed figures hold either way); adding a walk-in's details to their sale's invoice (nothing it
charges changes). A move-in's history from before its opening date goes in behind the lock, but
never into a year whose statements were approved; a company file doesn't bring an agreed year into
a year already closed, and a tracker import never replaces books with closed periods.

The lock date isn't a setting any more (from 1.24): Settings shows it.
Code: `apps/server/src/modules/periods.ts`, `lib/books.ts` (`assertOpen`, `applyMonthLock`),
`packages/shared/src/locks.ts`.
