#!/usr/bin/env bash
# Adds another company to this Shap server: its own database, login, keys and web address,
# sharing the Postgres and Caddy that are already running. Nothing is shared between companies
# except the machine: each one's data sits in its own database, under its own database login.
#
#   ./add-company.sh <short-name> <domain>
#   ./add-company.sh friend shap.friendsbuilding.co.za
#
# Point the domain's DNS A record at this VPS first, so Caddy can get its certificate.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
cd "$(dirname "$0")"

SLUG="${1:-}"
DOMAIN="${2:-}"
if ! [[ "$SLUG" =~ ^[a-z][a-z0-9]{1,19}$ ]] || [ -z "$DOMAIN" ]; then
  echo "Usage: ./add-company.sh <short-name> <domain>   (short name: lowercase letters and digits, e.g. friend)" >&2
  exit 1
fi
[ "$SLUG" = shap ] && { echo "Choose another short name." >&2; exit 1; }
[ -f .env ] || { echo "Set up the main company first (.env is missing)." >&2; exit 1; }
[ -f "companies/$SLUG.env" ] && { echo "There is already a company called $SLUG (companies/$SLUG.env)." >&2; exit 1; }
command -v openssl >/dev/null || { echo "Please install openssl." >&2; exit 1; }

DB="shap_$SLUG"
DB_PASSWORD="$(openssl rand -hex 24)"

# 1. Its own database and database login. Neither company's login can open the other's database.
docker compose exec -T db psql -U shap -d postgres -v ON_ERROR_STOP=1 -q <<SQL
create role $DB login password '$DB_PASSWORD';
create database $DB owner $DB;
revoke connect on database $DB from public;
revoke connect on database shap from public;
SQL

# 2. Its settings: address, database and its own encryption key.
mkdir -p companies
umask 077
cat > "companies/$SLUG.env" <<ENV
# Shap for "$SLUG" (created by add-company.sh). Keep this file private.
SHAP_DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
DATABASE_URL=postgres://$DB:$DB_PASSWORD@db:5432/$DB
SECRETS_KEY=$(openssl rand -base64 32)
MFA_REQUIRED=true
SESSION_TTL_HOURS=720
# Optional: email quotes and invoices from this company's own address.
# SMTP_URL=smtp://user:password@smtp.example.co.za:587
# MAIL_FROM=Their Company <accounts@theircompany.co.za>
ENV
umask 022

# 3. Its own app container (the same image as yours: updates reach every company at once).
if [ ! -f companies.yml ]; then
  cat > companies.yml <<'YML'
# Extra companies on this VPS, written by add-company.sh. Loaded with docker-compose.yml
# through COMPOSE_FILE in .env, so plain "docker compose ..." commands include them.
services:
YML
fi
cat >> companies.yml <<YML
  app-$SLUG:
    image: shap-app:local
    pull_policy: never
    restart: unless-stopped
    env_file: companies/$SLUG.env
    environment:
      NODE_ENV: production
      COOKIE_SECURE: 'true'
      TRUST_PROXY: 'true'
      TZ: Africa/Johannesburg
    expose:
      - '8080'
    depends_on:
      db:
        condition: service_healthy
YML
grep -q '^COMPOSE_FILE=' .env || printf '\n# Your company plus the ones add-company.sh added.\nCOMPOSE_FILE=docker-compose.yml:companies.yml\n' >> .env

# 4. Its web address.
mkdir -p sites
cat > "sites/$SLUG.caddy" <<CADDY
$DOMAIN {
	import shap app-$SLUG:8080
}
CADDY

docker compose up -d "app-$SLUG"
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

cat <<MSG

Added "$SLUG" at https://$DOMAIN

Create their owner login (they choose a password at first sign-in if you leave it out):
  docker compose exec app-$SLUG node apps/server/dist/db/create-owner.js --email them@theircompany.co.za --name "Their Name" --company "Their Company (Pty) Ltd"

Backups (deploy/backup/backup.sh) pick up the new database automatically.
MSG
