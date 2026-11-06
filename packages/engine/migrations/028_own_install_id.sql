-- Books started from the app's ready-made empty books (scripts/fresh-books.mjs) all had that
-- file's install id, so every phone on a build counted as one business for the anonymous market
-- rates and usage notes. Each set of books gets its own id now (new ones get theirs on first open).
update settings set install_id = gen_random_uuid();
