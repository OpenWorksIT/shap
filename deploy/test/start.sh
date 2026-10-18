#!/usr/bin/env bash
# Starts the Shap test stack on this PC and prints the address to use on your phone.
#   ./start.sh                     start (or restart) with the fictional demo company
#   ./start.sh --import FILE.xlsx  start fresh with YOUR tracker instead of the demo (asks for your login)
#   ./start.sh --import FILE.xlsx --company company.json
#                                  ...and load a Shap company file (trading names, logos, clients, agreed year ends)
#   ./start.sh --update            pull the latest code from GitHub and rebuild
#   ./start.sh --stop              stop everything (data is kept)
#   ./start.sh --reset             stop and DELETE all test data (the demo is reloaded next start)
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Please install $1 first." >&2; exit 1; }; }
need docker
need curl
need openssl
need python3
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is needed (docker compose ...)." >&2; exit 1; }

compose() { docker compose --env-file .env -f compose.yml "$@"; }
setenv() { # setenv KEY VALUE: replace or add a line in .env
  if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

IMPORT=""
COMPANY_FILE=""
case "${1:-}" in
  --stop) compose --profile named --profile quick down; exit 0 ;;
  --reset)
    read -r -p "Delete ALL Shap test data? Type yes: " ok
    [ "$ok" = yes ] || exit 1
    compose --profile named --profile quick down -v
    [ -f .env ] && setenv DEMO true
    exit 0 ;;
  --update)
    git -C ../.. pull --ff-only ;;
  --import)
    IMPORT="${2:-}"
    [ -f "$IMPORT" ] || { echo "Usage: ./start.sh --import path/to/tracker.xlsx" >&2; exit 1; }
    IMPORT="$(cd "$(dirname "$IMPORT")" && pwd)/$(basename "$IMPORT")"
    if [ "${3:-}" = --company ]; then
      COMPANY_FILE="${4:-}"
      [ -f "$COMPANY_FILE" ] || { echo "Usage: ./start.sh --import tracker.xlsx --company company.json" >&2; exit 1; }
      COMPANY_FILE="$(cd "$(dirname "$COMPANY_FILE")" && pwd)/$(basename "$COMPANY_FILE")"
    fi ;;
esac

rand() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }

# ---------- first run: keys and settings ----------
if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
# Shap test stack settings (created by start.sh). Keep this file private.
POSTGRES_PASSWORD=$(rand 24)
SECRETS_KEY=$(openssl rand -base64 32)
# Password for the demo logins (owner@, site@, accountant@example.co.za)
DEMO_PASSWORD=$(rand 12)
# true = load the fictional demo company on an empty database
DEMO=true

# Named tunnel (recommended): paste the token from Cloudflare and set the address you gave it.
# Leave empty to use a quick tunnel with a random trycloudflare.com address.
TUNNEL_TOKEN=
PUBLIC_URL=

# true = everyone must set up an authenticator app at sign-in (as on the real server)
MFA_REQUIRED=false

# Optional: email quotes and invoices
SMTP_URL=
ENV
  umask 022
  echo "Created deploy/test/.env"
fi
set -a; . ./.env; set +a

# Port on this PC. Steady's test stack uses 8090+, Sorted's 8180+, so Shap starts at 8280.
port_free() { python3 -c 'import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "$1" 2>/dev/null; }
if [ -z "${LOCAL_PORT:-}" ]; then
  compose --profile named --profile quick down >/dev/null 2>&1 || true
  for p in 8280 8281 8282 8283 8284 8285 8286 8287 8288 8289; do
    if port_free "$p"; then LOCAL_PORT=$p; break; fi
  done
  [ -n "${LOCAL_PORT:-}" ] || { echo "Ports 8280-8289 are all in use. Set LOCAL_PORT in deploy/test/.env." >&2; exit 1; }
  printf '\n# Port on this PC\nLOCAL_PORT=%s\n' "$LOCAL_PORT" >> .env
fi
export LOCAL_PORT
LOCAL="http://localhost:$LOCAL_PORT"

if [ -n "$IMPORT" ]; then
  echo "This starts Shap fresh with your tracker: the demo company (and anything else in the test stack) is deleted."
  read -r -p "Type yes to carry on: " ok
  [ "$ok" = yes ] || exit 1
  compose --profile named --profile quick down -v >/dev/null 2>&1 || true
  setenv DEMO false
  export DEMO=false
fi

# ---------- start ----------
if [ "${NO_TUNNEL:-}" = 1 ]; then PROFILE=none
elif [ -n "${TUNNEL_TOKEN:-}" ]; then PROFILE=named
else PROFILE=quick; fi
compose --profile named --profile quick down --remove-orphans >/dev/null 2>&1 || true
echo "Building and starting Shap (the first build takes a few minutes)..."
compose --profile "$PROFILE" up -d --build

echo -n "Waiting for Shap"
for _ in $(seq 1 90); do
  curl -fsS "$LOCAL/api/health" >/dev/null 2>&1 && break
  echo -n "."; sleep 2
done
echo
curl -fsS "$LOCAL/api/health" >/dev/null || { echo "Shap didn't start. See: docker compose -f deploy/test/compose.yml logs app" >&2; exit 1; }

# ---------- your own tracker ----------
if [ -n "$IMPORT" ]; then
  read -r -p "Your email (to sign in with): " OWNER_EMAIL
  read -r -p "Your name: " OWNER_NAME
  read -r -p "Company name (e.g. Construction Solutions (Pty) Ltd): " COMPANY
  read -r -s -p "Choose a password (10+ characters): " OWNER_PASSWORD; echo
  compose exec -T -e OWNER_PASSWORD="$OWNER_PASSWORD" app node apps/server/dist/db/create-owner.js --email "$OWNER_EMAIL" --name "$OWNER_NAME" --company "$COMPANY"
  compose cp "$IMPORT" app:/tmp/tracker.xlsx
  if [ -n "$COMPANY_FILE" ]; then
    compose cp "$COMPANY_FILE" app:/tmp/company.json
    compose exec -T app node apps/server/dist/db/import-cli.js /tmp/tracker.xlsx --company /tmp/company.json
  else
    compose exec -T app node apps/server/dist/db/import-cli.js /tmp/tracker.xlsx
  fi
  compose exec -T -u root app rm -f /tmp/tracker.xlsx /tmp/company.json || true
fi

# ---------- address ----------
URL="${PUBLIC_URL:-}"
if [ "$PROFILE" = quick ]; then
  echo -n "Waiting for the quick tunnel"
  for _ in $(seq 1 30); do
    URL=$(compose logs quicktunnel 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
    [ -n "$URL" ] && break
    echo -n "."; sleep 2
  done
  echo
fi

cat <<MSG

Shap test server is running.

  Address        ${URL:-(set PUBLIC_URL in deploy/test/.env to the hostname you gave the tunnel)}
  This PC        $LOCAL
MSG
if [ "${DEMO:-true}" = true ]; then
  cat <<MSG

  Demo company (fictional), password: $DEMO_PASSWORD
    owner@example.co.za       Owner: everything
    site@example.co.za        Site capture: log days and costs
    accountant@example.co.za  Accountant: read only

  To use your own tracker instead: ./start.sh --import path/to/tracker.xlsx
MSG
else
  echo
  echo "  Sign in with the owner login you created."
fi
cat <<MSG

  Phone: open the address, then Add to Home screen (Android) or Share > Add to Home Screen (iPhone).

MSG
if [ "$PROFILE" = quick ]; then
  echo "  Quick tunnel: the address changes every start. Set up a named tunnel for a fixed one (see deploy/test/README.md)."
  echo
fi
if command -v qrencode >/dev/null 2>&1 && [ -n "$URL" ]; then
  echo "  Scan with your phone:"
  qrencode -t ansiutf8 -m 2 "$URL"
fi
