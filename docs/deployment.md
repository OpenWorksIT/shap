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

Either upload it in the app under **Settings → Import tracker**, or on the server:

```bash
sudo docker compose cp ~/tracker.xlsx app:/tmp/tracker.xlsx
sudo docker compose exec app node apps/server/dist/db/import-cli.js /tmp/tracker.xlsx
sudo docker compose exec app rm /tmp/tracker.xlsx
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

## Updates

```bash
cd /opt/shap && sudo git pull && cd deploy/vps && sudo docker compose up -d --build
```

Database changes run by themselves when the app starts.

## Backups

[deploy/backup/backup.sh](../deploy/backup/backup.sh) dumps the database (including slip photos
and your logo), checks the dump can be read, and stores it encrypted and de-duplicated with
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
