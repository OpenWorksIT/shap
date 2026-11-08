# If support for Shap ends

Shap and Shap Pocket are looked after by OpenWorks IT, a small company. This is the plan for
the day that changes: so that everyone using either app hears about it in the app, in good time,
and nobody loses their books.

## What keeps working

- **Every copy keeps working.** Shap runs on the owner's own server and Shap Pocket on the phone
  or in the browser. Neither needs OpenWorks to open the books, add invoices or make backups.
- **The source code stays published** (GNU AGPL v3) on GitHub, so anyone can keep it going, fix
  it or take it over.
- **What stops:** updates (security fixes, and new tax tables, VAT and payroll rules each year),
  the anonymous feedback and usage collector, and help from OpenWorks.

## How everyone is told

Both apps read one small public file, [`notice.json`](notice.json) in this repository, from
GitHub (not from OpenWorks' servers, so it works even if those are gone):

- Shap reads it twice a day on the server and shows it at the top of the app.
- Shap Pocket reads it when it opens with an internet connection.

A notice with `"level": "sunset"` can't be put away: it stays at the top of every screen until
the copy is updated or removed.

### To announce the end of support

Give at least six months' notice. Add this to `notices` in `notice.json`, commit it to `main`,
and it reaches every copy that's online within a day:

```json
{
  "id": "sunset-2027",
  "level": "sunset",
  "title": "OpenWorks will stop supporting Shap",
  "body": "Your books keep working, and the code stays free for anyone to continue. Keep making backups. Before the date, export your company file and the accountant's export (Settings), and file what's due with your accountant.",
  "supportEndsOn": "2027-12-31",
  "link": "https://github.com/OpenWorksIT/shap/blob/main/SUNSET.md",
  "apps": ["shap", "pocket"]
}
```

Other levels: `info`, `update` (with `"belowVersion": "1.17.0"` it shows only on older copies)
and `warning`. Notices are plain text; links are only followed to openworks.co.za and github.com.

### Then

1. Publish one last update of both apps with the latest tax tables, and say in its changelog
   that it is the last from OpenWorks.
2. Put the same notice on the website (openworks.co.za/shap) and in the store listings.
3. Leave the GitHub repositories public (archive them rather than delete them), and the notice
   file in place.
4. If someone is taking Shap over, say who in the notice and link to their repository.
5. Switch off the collector (shap.openworks.co.za) last: the apps carry on without it.

## Who can do this

Today it is Tiaan van der Merwe (OpenWorks IT). So that it doesn't depend on one person, a
second trusted owner should be added to the OpenWorksIT GitHub organisation, with this page, so
they can publish the notice if Tiaan can't.

## What a user should do

- Keep backups going: Shap's nightly backups (or Settings → Updates & backups), Shap Pocket's
  Backup screen. Keep a copy somewhere other than where the app runs.
- Export the company file and the accountant's export, and keep the PDFs of what was issued:
  SARS expects records for five years.
- Carry on using the last version for as long as it suits; check new tax tables with an
  accountant, since the app won't get them.
