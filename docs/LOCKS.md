# Locks: month end and closed years

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
  Each one is in the audit log, by "month end, by itself". It locks once: a month reopened after its
  day stays open until the next month's day, which closes both.

## A business that doesn't sell: the year

The year is closed once the accountant has signed it off: under Accounts → Locks, or with the year
end ("lock the books"), or when the financial statements are approved.

## Putting something right in a closed period

Someone who may close and reopen **reopens** it from a month (or year): that month and everything
after it opens again. They say why; the reason, who and when are kept in the audit log, and Home
shows the books are reopened. Put it right, then **Lock it again** (back to where it was).

- A year whose financial statements were approved stays closed until the statements are reopened
  (Accounts → Financial statements, with the reason).
- A year agreed with the accountant keeps its agreed figures whatever's posted into it after; the
  difference goes to suspense for them to look at (docs/STATEMENTS.md).

The lock date isn't a setting any more (from 1.24): Settings shows it, and it moves only here.
Code: `apps/server/src/modules/periods.ts`, `lib/books.ts` (`assertOpen`, `applyMonthLock`),
`packages/shared/src/locks.ts`.
