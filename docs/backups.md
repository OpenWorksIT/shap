# Backups

Everything Shap knows (jobs, labour, costs, quotes and invoices, the books, slip photos and
logos) lives in one Postgres database per company. A backup is a full dump of it.

## On the server

Once [`deploy/vps/ctl/install.sh`](../deploy/vps/ctl/install.sh) has run (see
[deployment](deployment.md#updates)), the server:

- backs up every night at 02:30 and before every update, into `/var/backups/shap`
  (each dump is checked to be readable before it's kept);
- keeps the last 14 nightly backups, and the last 5 made by hand or before an update.

**Settings → Updates & backups** shows the backups, makes one on demand, and downloads any of them.

## On your PC

The server's copies don't help if the server is lost, so your PC fetches them a few times a
day while it's on, over your normal SSH login. Set it up once, on the PC (Linux, as yourself):

```bash
scp -r vps1:/opt/shap/deploy/backup/pc /tmp/shap-pc && bash /tmp/shap-pc/install-on-pc.sh
```

Copies go to `~/Backups/Shap` and are kept for a year. If the PC can't reach the server for
three days, it tells you. Settings → Updates & backups shows when the PC last took a copy.
`vps1` is the server's name in your `~/.ssh/config`; if yours differs, edit `SHAP_HOST` at the
top of `~/.local/bin/shap-pull.sh`. Your SSH key must be usable without typing a passphrase
while you're logged in (an agent or unlocked vault is fine).

The dumps hold your clients' details and your books: keep the folder private, and include it in
whatever backs up your PC.

For a second, off-site copy as well (an S3 bucket or a storage box), see
[`deploy/backup/backup.sh`](../deploy/backup/backup.sh) (restic, encrypted).

## Restoring

This replaces everything in the company's database with the backup. Make a backup of the
current state first (the first command below) in case you need to go back.

The database is dropped and created fresh, then the backup is restored into it. (Restoring over
the existing database with `pg_restore --clean` doesn't work once the backup is from an older
version: tables added since are left in place and the restore fails half-way.) When Shap starts
again it brings the restored database up to the current version by itself.

```bash
# a backup from your PC goes back to the server first:
scp ~/Backups/Shap/shap-daily-2026-10-19_0230.dump vps1:/tmp/

cd /opt/shap/deploy/vps
sudo /opt/shap/deploy/vps/ctl/shap-ctl.sh backup     # the current state, just in case
sudo docker compose stop app
sudo docker compose exec -T db dropdb -U shap shap
sudo docker compose exec -T db createdb -U shap shap
sudo sh -c 'docker compose exec -T db pg_restore -U shap -d shap --no-owner --exit-on-error < /tmp/shap-daily-2026-10-19_0230.dump'
sudo docker compose start app
sudo docker compose logs --tail 20 app                # "applied …" lines: brought up to date
```

Everyone signs in again afterwards. For another company on the same server, use its database
(`shap_<name>`) and its app container (`app-<name>`). To look at an old backup without touching
the real one, restore it into a new database (`docker compose exec db createdb -U shap
shap_restore`) and inspect that.
