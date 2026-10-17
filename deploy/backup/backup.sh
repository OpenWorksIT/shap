#!/usr/bin/env bash
# Shap backups: an encrypted, deduplicated restic snapshot of a full dump of every company's database
# (jobs, costs, labour, invoices, the books, slip photos and logo all live in Postgres).
#
# Install on the VPS: copy shap-backup.service and .timer to /etc/systemd/system, set
# RESTIC_REPOSITORY in the service, then: systemctl enable --now shap-backup.timer
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/shap/deploy/vps}"
STAGING="${STAGING:-/var/backups/shap}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/root/.restic-password}"
REPO="${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (e.g. s3:https://... or sftp:user@host:/srv/backups/shap)}"

mkdir -p "$STAGING"
chmod 700 "$STAGING"
stamp="$(date +%Y-%m-%dT%H%M)"

cd "$COMPOSE_DIR"
# Every company on this server: shap (yours) and shap_<name> for each one add-company.sh added.
dbs=$(docker compose exec -T db psql -U shap -d postgres -Atc "select datname from pg_database where datname = 'shap' or datname like 'shap\_%' order by 1")
dumps=()
for db in $dbs; do
  dump="$STAGING/$db-$stamp.dump"
  docker compose exec -T db pg_dump -U shap -d "$db" -Fc > "$dump"
  # Make sure the dump is readable before we trust it.
  docker compose exec -T db pg_restore --list < "$dump" > /dev/null
  dumps+=("$dump")
done

restic -r "$REPO" backup --tag shap --host shap-vps "${dumps[@]}"
restic -r "$REPO" forget --tag shap --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-yearly 7 --prune

# Keep only the last 3 dumps of each database on the VPS itself.
for db in $dbs; do
  ls -1t "$STAGING/$db"-2*.dump | tail -n +4 | xargs -r rm --
done

echo "backup ok: $stamp"
