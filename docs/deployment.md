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

To email quotes and invoices from Shap (and send monthly invoices by themselves), give it a
mailbox to send from. Any mailbox with SMTP works: the one that comes with your domain's
hosting is fine. In `/opt/shap/deploy/vps/.env`:

```bash
# Port 465 (TLS from the start): smtps://   Port 587 (STARTTLS): smtp://
# The username is usually the full email address. Write @ as %40 and any other
# symbol in the password URL-encoded: # → %23, / → %2F, : → %3A, $ → %24, % → %25, @ → %40.
SMTP_URL=smtps://invoices%40yourdomain.co.za:the-password@mail.yourdomain.co.za:465
MAIL_FROM=Your Company <invoices@yourdomain.co.za>
```

Then `sudo docker compose up -d` (or **Settings → Updates & backups → Update**). The startup log
says `Email: on`. Email an invoice to yourself to check.

Each email shows the invoice's trading name as the sender (with the `MAIL_FROM` address), and
replies go to that trading name's email (Settings → Trading names), or the company email. So
one mailbox serves every trading name. To keep it out of spam folders, the sending domain's
DNS should have SPF (and ideally DKIM) records that include the mail server; your mail host
lists them.

Without email, use **Share PDF**, which hands the PDF to WhatsApp or email on a phone and
downloads it on a PC. Monthly invoices set to email are then made and issued but not sent, and
Home says so.

## 6. Feedback and bug reports

Every screen has a **Feedback** button (love it, don't like it, bug found). Reports are kept on
your server in the `feedback` volume (`/data/feedback`, one folder per report with a masked
screenshot for bugs and the steps that led up to it) and shown to the owner under
**Settings → Feedback**. They're also passed on to OpenWorks, who make Shap (a screenshot only
if it was masked); set `COLLECTOR_URL=off` in `.env` to keep them on your server only.

If the owner agrees (Settings → What you use), Shap also tells OpenWorks, anonymously, what kind
of business uses it and which parts are switched on: never names, clients or figures.

OpenWorks' own server runs with `COLLECT=true`, which also receives feedback and these notes from
Shap Pocket (the phone app has no server of its own) at `/collect/feedback` and `/collect/usage`.
Both are open to anyone, limited per address and per day, and only accept words, a small
screenshot and the anonymous fields.

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

Point each site at a container name that's unique on that network (Shap's own is `shap-app`),
not a generic `app`: names on the shared network are visible to Caddy from every app.

Then follow the other app's own instructions (Steady: docs/DEPLOY.md, "Sharing a server").

## Company file

**Settings → Import & company file → Save company file** downloads everything that sets Shap up
(trading names and logos, company details, numbering and terms, your lists and accounts, clients
and the accountant's agreed year ends) as one JSON file, without the day-to-day records. Loading
one merges it in. With the tracker import: `./start.sh --import tracker.xlsx --company company.json`
on the test stack, or `npm run import -- tracker.xlsx --company company.json` on a server. Company
files hold client details and figures: keep them out of git.

## Updates

Once, on the server:

```bash
sudo /opt/shap/deploy/vps/ctl/install.sh
```

After that, **Settings → Updates & backups** shows the version, checks GitHub (also every
night), lists what's new, and updates with one button: it backs up, pulls the new version,
rebuilds and restarts, and the page reloads when Shap is back. Database changes run by
themselves when the app starts. The app never gets Docker or root: it leaves a request that
`shap-ctl` (a small root service on the server, [`deploy/vps/ctl`](../deploy/vps/ctl)) picks up.

By hand, the same thing is:

```bash
cd /opt/shap && sudo git pull && cd deploy/vps && sudo docker compose up -d --build
```

## Backups

Every night and before every update, kept on the server and copied to your PC. See
[backups.md](backups.md), including how to restore.

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
- The app can read shap-ctl's status and the backups, but writes only its single request file (a
  read-only mount and a separate drop-box), and runs with `no-new-privileges` and all Linux
  capabilities dropped, so a compromise of the app can't reach root on the host.

### Hardening you may want to add

These aren't set up automatically; they suit a server hosting several companies or a higher-risk
setup.

- **Give the app a least-privilege database login.** The default compose connects the main app as
  the `shap` Postgres superuser (the official image makes `POSTGRES_USER` a superuser). A SQL-level
  flaw in the app would then have superuser reach over every company's database. To reduce the
  blast radius, create a non-superuser role that owns only the `shap` database and point
  `DATABASE_URL` at it, keeping `shap` for admin scripts only:

  ```sql
  create role shap_app login password '…';
  alter database shap owner to shap_app;
  revoke all on database shap from public;
  grant connect on database shap to shap_app;
  ```

  Pre-create the demo database (`createdb -O shap_app shap_demo`) so the app never needs
  `CREATEDB`. (Tenant companies added with `add-company.sh` already use their own non-superuser
  roles.)
- **Update from signed releases, not branch tips.** "Update" pulls `main` from GitHub and rebuilds
  on the server, so whoever controls that branch or the GitHub account controls the server. For a
  stricter chain, track signed, annotated release tags and verify them (`git verify-tag`) before
  building, and pin the base images (`node`, `postgres`, `caddy`) by `@sha256:` digest rather than
  the floating `:16`/`:2` tags.
