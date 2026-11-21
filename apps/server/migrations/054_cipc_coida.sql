-- Reminders for CIPC's annual return and the Compensation Fund's return of earnings (1.33): the
-- date a company or CC was incorporated (its registration certificate), and whether the business is
-- registered with the Compensation Fund (COIDA). Unknown until the owner says (null).
alter table settings add column if not exists incorporated_on date;
alter table settings add column if not exists coida_registered boolean;
