-- Sales and stock (docs/SALES_AND_STOCK.md).
--
-- Sales: a sale is a document of its own kind, paid on the spot (a receipt), with no client
-- needed: a walk-in's till slip. It posts like an invoice paid at once. It can become an invoice
-- later (a client added, its own sale number kept), and it's taken back by a credit note, refunded
-- in money (a refund out of the till or bank). Nothing is ever deleted: a mistake is refunded.
--
-- Stock: each stocked item's quantity and value at weighted average cost (IFRS for SMEs 13.18),
-- moved only by entries that can't be changed or deleted (stock_moves): purchases, returns to the
-- supplier, sales and invoices, refunds back into stock, stock takes, and the cost corrections when
-- stock sold before it was bought arrives. Every movement posts the inventory account against the
-- other side, so the books and the stock always agree (the books audit checks it).
--   Purchases are costs (so bills, payments, the bank and the VAT201 work as for any cost) on the
--   "Stock purchases" cost type, whose account is a clearing account: each line received into
--   stock takes its value out of it, and anything invoiced but not delivered becomes a claim
--   against the supplier, so it's always empty again.
--   A supplier's credit (a negative cost on the same type) clears that claim.

-- ---------------------------------------------------------------- accounts
create or replace function ensure_account(p_key text, p_name text, p_type text, p_codes text[]) returns uuid
language plpgsql as $$
declare v uuid; c text;
begin
  select id into v from accounts where system_key = p_key;
  if v is not null then return v; end if;
  foreach c in array p_codes loop
    if not exists (select 1 from accounts where code = c) then
      insert into accounts (code, name, type, system_key) values (c, p_name, p_type, p_key) returning id into v;
      return v;
    end if;
  end loop;
  -- Every usual code taken (a chart of accounts of its own): the first with a suffix that's free,
  -- so updating never fails over it. The owner can renumber it in Settings.
  for i in 1..999 loop
    c := p_codes[1] || '.' || i;
    if not exists (select 1 from accounts where code = c) then
      insert into accounts (code, name, type, system_key) values (c, p_name, p_type, p_key) returning id into v;
      return v;
    end if;
  end loop;
  raise exception 'no free account code for %', p_key;
end $$;

select ensure_account('revenue_goods', 'Sales – goods', 'income', array['4030', '4031', '4032', '4039']);
select ensure_account('cos_goods', 'Cost of sales – goods', 'cost_of_sales', array['5030', '5031', '5032', '5039']);
select ensure_account('stock_losses', 'Stock losses and write-downs', 'cost_of_sales', array['5040', '5041', '5042', '5049']);
select ensure_account('inventory', 'Inventory (stock on hand)', 'asset', array['1300', '1301', '1302', '1309']);
select ensure_account('supplier_claims', 'Claims against suppliers (short or returned stock)', 'asset', array['1310', '1311', '1312', '1319']);
select ensure_account('stock_clearing', 'Stock purchases (clearing)', 'liability', array['2060', '2061', '2062', '2069']);
select ensure_account('stock_opening', 'Opening stock (to match the opening balances)', 'liability', array['2065', '2066', '2067', '2068']);

-- The till: cash takings, on the cash-on-hand account (made if there isn't one).
do $$
declare cash_acc uuid;
begin
  select id into cash_acc from accounts where code = '1050' and type = 'asset';
  if cash_acc is null then
    select id into cash_acc from accounts where type = 'asset' and name ~* '\mcash on hand\M' limit 1;
  end if;
  if cash_acc is null then
    insert into accounts (code, name, type) select c, 'Cash on hand (till)', 'asset'
      from unnest(array['1050', '1051', '1052', '1059']) c where not exists (select 1 from accounts where code = c) limit 1
      returning id into cash_acc;
  end if;
  if cash_acc is null then
    insert into accounts (code, name, type) select c, 'Cash on hand (till)', 'asset'
      from (select '1050.' || i as c from generate_series(1, 999) i) x where not exists (select 1 from accounts where code = x.c) limit 1
      returning id into cash_acc;
  end if;
  alter table payment_sources add column if not exists till boolean not null default false;
  if not exists (select 1 from payment_sources where till) then
    insert into payment_sources (name, kind, account_id, active, sort, till)
    values (case when exists (select 1 from payment_sources where name = 'Till (cash sales)') then 'Till (cash sales) ' || substr(md5(random()::text), 1, 4) else 'Till (cash sales)' end,
            'cash', cash_acc, false, 4, true);
  end if;
end $$;

-- ---------------------------------------------------------------- documents: sales
alter table documents drop constraint if exists documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('quote', 'invoice', 'credit_note', 'sale'));
alter table documents drop constraint if exists documents_check;
alter table documents add constraint documents_check check (
  (kind = 'quote' and status in ('draft', 'sent', 'accepted', 'declined'))
  or (kind in ('invoice', 'credit_note') and status in ('draft', 'issued', 'void'))
  or (kind = 'sale' and status = 'issued'));
-- The sale's own number, kept when it becomes an invoice; and a walk-in's name on the slip.
alter table documents add column if not exists sale_number text;
alter table documents add column if not exists customer_name text not null default '';
alter table documents add column if not exists invoiced_at timestamptz;
-- When an invoice, sale or credit note was issued (the moment stock moves on it).
alter table documents add column if not exists issued_at timestamptz;
-- The sale's own payment (taken on the spot): it stays, as the sale does.
alter table documents add column if not exists sale_receipt_id uuid references receipts(id);
create unique index if not exists documents_sale_number on documents (sale_number) where sale_number is not null;
alter table settings add column if not exists sale_prefix text not null default 'SL';
alter table settings add column if not exists sale_next int not null default 1;
alter table settings add column if not exists sale_pad int not null default 5;

-- Lines: goods (sold from stock or not), the item sold, and on a credit note the line it takes
-- back and whether the goods went back into stock.
alter table document_lines drop constraint if exists document_lines_category_check;
alter table document_lines add constraint document_lines_category_check check (category in ('labour', 'materials', 'demo', 'other', 'goods'));
alter table document_lines add column if not exists item_id uuid references items(id);
alter table document_lines add column if not exists credited_line_id uuid references document_lines(id);
alter table document_lines add column if not exists restock boolean not null default false;
create index if not exists document_lines_item on document_lines (item_id) where item_id is not null;

-- A supplier's credit note (a negative cost on "Not paid yet") taken off one of their bills: a
-- bill payment made with the credit instead of money (it posts nothing: both sides are creditors).
alter table bill_payments add column if not exists credit_cost_id uuid references costs(id) on delete cascade;
create index if not exists bill_payments_credit on bill_payments (credit_cost_id) where credit_cost_id is not null;

-- Refunds: a credit note paid back in money (rather than taken off what's still owed).
create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null unique references documents(id),
  date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  source_id uuid not null references payment_sources(id),
  method text not null default 'cash' check (method in ('eft', 'cash', 'card', 'other')),
  reference text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- items and stock
alter table items add column if not exists sku text not null default '';
alter table items add column if not exists vat_code text not null default 'standard';
do $$ begin
  alter table items add constraint items_vat_code check (vat_code in ('standard', 'zero', 'export', 'exempt'));
exception when duplicate_object then null; end $$;
-- Prices typed as on the shelf (VAT included) or not; the usual lines brought in before were excluding.
alter table items add column if not exists price_includes_vat boolean not null default false;
alter table items add column if not exists stocked boolean not null default false;
alter table items add column if not exists qty_on_hand numeric(14, 3) not null default 0;
alter table items add column if not exists stock_value_cents bigint not null default 0;
-- Per unit, excluding VAT: the latest purchase's, for anything sold before it's in stock.
alter table items add column if not exists last_cost_cents bigint not null default 0;
alter table items add column if not exists reorder_level numeric(14, 3) not null default 0;
-- Since when its stock has been kept (lines issued before then never moved stock).
alter table items add column if not exists stocked_since timestamptz;
alter table items add column if not exists updated_at timestamptz not null default now();
create unique index if not exists items_sku on items (lower(sku)) where sku <> '';

alter table cost_categories drop constraint if exists cost_categories_kind_check;
alter table cost_categories add constraint cost_categories_kind_check check (kind in ('materials', 'demo', 'overhead', 'asset', 'personal', 'stock'));
insert into cost_categories (name, kind, account_id, active, sort)
select 'Stock purchases', 'stock', sys_account('stock_clearing'), false, 95
where not exists (select 1 from cost_categories where kind = 'stock');

-- A stock purchase's lines: what was invoiced and what arrived.
create table if not exists stock_purchase_lines (
  id uuid primary key default gen_random_uuid(),
  cost_id uuid not null references costs(id),
  item_id uuid not null references items(id),
  qty_invoiced numeric(14, 3) not null check (qty_invoiced > 0),
  qty_received numeric(14, 3) not null check (qty_received >= 0 and qty_received <= qty_invoiced),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  line_cents bigint not null,
  vat_code text not null default 'standard',
  sort int not null default 0
);
create index if not exists stock_purchase_lines_cost on stock_purchase_lines (cost_id);

create table if not exists stock_takes (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- What was counted, item by item (also where nothing differed: the count itself is the record).
create table if not exists stock_take_lines (
  id uuid primary key default gen_random_uuid(),
  stock_take_id uuid not null references stock_takes(id),
  item_id uuid not null references items(id),
  system_qty numeric(14, 3) not null,
  counted_qty numeric(14, 3) not null check (counted_qty >= 0),
  reason text not null default ''
);
create index if not exists stock_take_lines_take on stock_take_lines (stock_take_id);

-- A claim against a supplier: stock invoiced but not delivered, or sent back (received in bad
-- order, wrong item). Settled by the supplier's credit, or written off.
create table if not exists stock_claims (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  kind text not null check (kind in ('short', 'return')),
  supplier text not null default '',
  item_id uuid not null references items(id),
  cost_id uuid references costs(id),
  qty numeric(14, 3) not null check (qty > 0),
  value_cents bigint not null check (value_cents > 0),
  reason text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table if not exists stock_claim_settlements (
  id uuid primary key default gen_random_uuid(),
  -- Null for the part of a supplier's credit beyond any claim: a discount on stock bought.
  claim_id uuid references stock_claims(id),
  date date not null,
  kind text not null check (kind in ('credit', 'write_off', 'discount')),
  amount_cents bigint not null check (amount_cents > 0),
  cost_id uuid references costs(id),
  reason text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((kind = 'discount') = (claim_id is null)),
  check (kind = 'write_off' or cost_id is not null)
);

create table if not exists stock_moves (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null unique,
  item_id uuid not null references items(id),
  date date not null,
  kind text not null check (kind in ('opening', 'purchase', 'supplier_return', 'sale', 'refund', 'count', 'revalue', 'void')),
  qty numeric(14, 3) not null,
  value_cents bigint not null,
  -- Where the value went (or came from): the account on the other side of the inventory.
  contra text not null check (contra in ('stock_clearing', 'supplier_claims', 'cos_goods', 'stock_losses', 'stock_opening')),
  document_id uuid references documents(id),
  document_line_id uuid references document_lines(id),
  cost_id uuid references costs(id),
  purchase_line_id uuid references stock_purchase_lines(id),
  stock_take_id uuid references stock_takes(id),
  claim_id uuid references stock_claims(id),
  reverses_id uuid references stock_moves(id),
  reason text not null default '',
  -- The item's stock after this movement (its history reads straight down).
  qty_after numeric(14, 3) not null,
  value_after_cents bigint not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists stock_moves_item on stock_moves (item_id, seq);
create index if not exists stock_moves_document on stock_moves (document_id) where document_id is not null;
create index if not exists stock_moves_cost on stock_moves (cost_id) where cost_id is not null;

-- What's recorded stays recorded: corrections are new entries (a refund, a return, a count).
create or replace function stock_record_fixed() returns trigger language plpgsql as $$
begin
  raise exception 'Stock records can''t be changed or deleted: record a correction instead' using errcode = 'P0001';
end $$;
drop trigger if exists stock_moves_fixed on stock_moves;
create trigger stock_moves_fixed before update or delete on stock_moves for each row execute function stock_record_fixed();
drop trigger if exists stock_claims_fixed on stock_claims;
create trigger stock_claims_fixed before update or delete on stock_claims for each row execute function stock_record_fixed();
drop trigger if exists stock_claim_settlements_fixed on stock_claim_settlements;
create trigger stock_claim_settlements_fixed before update or delete on stock_claim_settlements for each row execute function stock_record_fixed();
drop trigger if exists stock_purchase_lines_fixed on stock_purchase_lines;
create trigger stock_purchase_lines_fixed before update or delete on stock_purchase_lines for each row execute function stock_record_fixed();
drop trigger if exists stock_takes_fixed on stock_takes;
create trigger stock_takes_fixed before update or delete on stock_takes for each row execute function stock_record_fixed();
drop trigger if exists stock_take_lines_fixed on stock_take_lines;
create trigger stock_take_lines_fixed before update or delete on stock_take_lines for each row execute function stock_record_fixed();
drop trigger if exists refunds_fixed on refunds;
create trigger refunds_fixed before update or delete on refunds for each row execute function stock_record_fixed();
