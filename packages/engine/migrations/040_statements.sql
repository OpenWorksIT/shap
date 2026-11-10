-- The annual financial statements (apps/server/src/statements, docs/STATEMENTS.md): the words
-- around the figures, kept once for the business, and each year's statements from draft to signed.
--   draft     built from the books, as they are
--   sent      emailed to the accountant to compile
--   compiled  the accountant signed the compiler's report (in Shap, or uploaded): the figures are
--             frozen as they were signed
--   approved  the directors (members, trustees…) approved and signed: the year is agreed at those
--             figures and closed, and the signed set is kept
create table if not exists statement_details (
  id boolean primary key default true check (id),
  details jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists financial_statements (
  fy_end date primary key,
  status text not null default 'draft' check (status in ('draft', 'sent', 'compiled', 'approved')),
  -- The statements as compiled (and approved), and a fingerprint of them.
  snapshot jsonb,
  snapshot_hash text,
  sent_to text not null default '',
  sent_at timestamptz,
  compiled_by uuid references users(id),
  compiler jsonb,
  compiled_on date,
  compiled_at timestamptz,
  compiler_report_id uuid references attachments(id),
  approved_by uuid references users(id),
  approved_name text not null default '',
  approved_on date,
  approved_at timestamptz,
  final_pdf_id uuid references attachments(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
