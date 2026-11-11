-- A VAT vendor that doesn't sell closes each VAT period (1.26: docs/LOCKS.md), by hand or by itself.
-- Month end "by itself" was a choice about months, made with Sales on: books that kept it after
-- switching Sales off never chose to lock VAT periods by themselves. They close by hand from here
-- (Home reminds them), and the owner chooses again under Accounts → Locks.
update settings set month_end_mode = 'manual'
where month_end_mode = 'auto' and not coalesce((features ->> 'sales')::boolean, false);
