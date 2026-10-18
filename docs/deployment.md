# Deploying Shap

One server: a VPS in South Africa running Postgres, Shap and Caddy (HTTPS) with Docker Compose.
You open it on your PC and phone at an address like `https://shap.yourcompany.co.za`.

For testing on a PC first, use [deploy/test](../deploy/test/README.md).

## Before you start

- A small VPS in South Africa (1–2 vCPU, 2 GB RAM and 20 GB SSD is plenty), running Debian or
  Ubuntu Server.
- A hostname with a DNS **A record** pointing at the VPS, e.g. `shap.openworks.co.za`.

## 1. Install

```bash
sudo apt install docker.io docker-compose-v2 restic
sudo git clone https://github.com/OpenWorksIT/shap /opt/shap
cd /opt/shap/deploy/vps
sudo cp .env.example .env && sudo chmod 600 .env
sudo nano .env      # SHAP_DOMAIN, and two secrets from: openssl rand -base64 32
sudo docker compose up -d --build
sudo docker compose exec app node apps/server/dist/db/create-owner.js \
  --email you@yourcompany.co.za --name "Your Name" --company "Your Company (Pty) Ltd"
```

Open `https://shap.yourcompany.co.za`. Caddy gets the certificate by itself. Sign in, set up your
authenticator app when asked (Aegis, FreeOTP, Google or Microsoft Authenticator), and save the
recovery codes.

## 2. Bring your tracker across

Either upload it in the app under **Settings → Import & company file**, or on the server
(`--company` is optional; see [Company file](#company-file)):

```bash
sudo docker compose cp ~/tracker.xlsx app:/tmp/tracker.xlsx
sudo docker compose cp ~/company.json app:/tmp/company.json
sudo docker compose exec app node apps/server/dist/db/import-cli.js /tmp/tracker.xlsx --company /tmp/company.json
sudo docker compose exec -u root app rm -f /tmp/tracker.xlsx /tmp/company.json   # docker cp leaves them root-owned
shred -u ~/tracker.xlsx ~/company.json
```

Then follow *After the import* in [importing.md](importing.md).

## 3. Phone

Open the address in Chrome (Android) and choose **Add to Home screen**, or in Safari (iPhone)
choose **Share → Add to Home Screen**. Shap then opens full screen like an app, with the shaka
icon. Sessions last 30 days of not using it (`SESSION_TTL_HOURS`).

## 4. Other people

**Settings → People who sign in**:

| Access | For |
|---|---|
| Owner | You: everything |
| Site capture | A foreman: logs days and costs (with slip photos) and sees jobs, but no money figures |
| Accountant | Your accountant: reads and exports everything, changes nothing |

## 5. Email (optional)

To email quotes and invoices from Shap, set `SMTP_URL` and `MAIL_FROM` in `.env` and run
`docker compose up -d`. Without it, use **Share PDF**, which hands the PDF to WhatsApp or email
on a phone and downloads it on a PC.

## Another company on the same server

Shap can run a second business (a friend's, say) on the same VPS without a second server. Each
company gets its own database and database login, its own encryption key, its own owner login
and its own web address; Postgres and Caddy are shared, and one update reaches every company.
A company of one or two people doing daily admin uses very little: each extra company adds an
app container of roughly 100 MB of memory, so a 2 GB VPS has room for several.

```bash
cd /opt/shap/deploy/vps
sudo ./add-company.sh friend shap.friendsbuilding.co.za     # point that domain's DNS at the VPS first
sudo docker compose exec app-friend node apps/server/dist/db/create-owner.js \
  --email them@theircompany.co.za --name "Their Name" --company "Their Company (Pty) Ltd"
```

Their settings and keys are in `deploy/vps/companies/friend.env` (email settings go there too).
Backups include every company's database. To take a company off the server, stop its container
(`docker compose rm -sf app-friend`), delete its block from `companies.yml`, its `sites/friend.caddy`
and `companies/friend.env`, and drop the database once you have a backup.

## Other apps on the same server

Shap's Caddy can also be the front door for other apps on the VPS (on vps1: Steady), so they
don't fight over ports 80 and 443. The other app joins a shared Docker network called `edge`,
and its site goes in `deploy/vps/sites/`:

```bash
sudo docker network create edge                      # once
# in deploy/vps/.env, add edge.yml to COMPOSE_FILE (keep companies.yml if it's there):
#   COMPOSE_FILE=docker-compose.yml:edge.yml
sudo docker compose up -d caddy
```

Then follow the other app's own instructions (Steady: docs/DEPLOY.md, "Sharing a server").

## Company file

**Settings → Import & company file → Save company file** downloads everything that sets Shap up
(trading names and logos, company details, numbering and terms, your lists and accounts, clients
and the accountant's agreed year ends) as one JSON file, without the day-to-day records. Loading
one merges it in. With the tracker import: `./start.sh --import tracker.xlsx --company company.json`
on the test stack, or `npm run import -- tracker.xlsx --company company.json` on a server. Company
files hold client details and figures: keep them out of git.

## Updates

```bash
cd /opt/shap && sudo git pull && cd deploy/vps && sudo docker compose up -d --build
```

Database changes run by themselves when the app starts.

## Backups

[deploy/backup/backup.sh](../deploy/backup/backup.sh) dumps every company's database (including
slip photos and logos), checks each dump can be read, and stores it encrypted and de-duplicated with
restic, ideally at a second provider (an S3-compatible bucket, a Hetzner storage box, or your
PC over SFTP).

```bash
sudo cp /opt/shap/deploy/backup/shap-backup.{service,timer} /etc/systemd/system/
sudo sh -c 'openssl rand -base64 32 > /root/.restic-password && chmod 600 /root/.restic-password'
sudo nano /etc/systemd/system/shap-backup.service   # set RESTIC_REPOSITORY
sudo restic -r <repository> init --password-file /root/.restic-password
sudo systemctl enable --now shap-backup.timer
```

**Keep a copy of `/root/.restic-password` somewhere safe off the server.** Without it the backups
can't be opened. Try a restore once:

```bash
restic -r <repository> restore latest --target /tmp/restore
docker compose exec -T db pg_restore -U shap -d shap --clean --if-exists < /tmp/restore/var/backups/shap/shap-*.dump
```

## Firewall

Allow 80 and 443 (Caddy), and SSH from your own addresses only. Postgres is never published.

## Security notes

- Two-factor sign-in is required on the VPS by default (`MFA_REQUIRED=true`), with ten
  single-use recovery codes. An owner can reset someone's lost authenticator.
- Passwords are hashed with Argon2id; sessions are opaque tokens stored as SHA-256 hashes;
  sign-in is rate-limited.
- Every change (costs, labour, invoices, journals, settings, users) is written to an
  append-only audit log, which the database won't let anyone edit or delete.
- A lock date stops anything in a closed financial year from being changed.
