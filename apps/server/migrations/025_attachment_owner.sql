-- Who uploaded each attachment, so site capture can be limited to the files it uploaded itself.
-- Authorising a capture read by "a cost they created points at this attachment" was unsafe: a
-- cost's receipt_id is caller-supplied, so capture could create a cost pointing at any attachment
-- id (e.g. a bank-statement PDF) and read it. Ownership is the attachment's own, not a forgeable
-- link through another row.
alter table attachments add column if not exists created_by uuid references users(id);
