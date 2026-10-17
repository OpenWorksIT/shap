#!/usr/bin/env bash
# Shap backups: an encrypted, deduplicated restic snapshot of a full database dump
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
dump="$STAGING/shap-$stamp.dump"

cd "$COMPOSE_DIR"
docker compose exec -T db pg_dump -U shap -d shap -Fc > "$dump"
# Make sure the dump is readable before we trust it.
docker compose exec -T db pg_restore --list < "$dump" > /dev/null

restic -r "$REPO" backup --tag shap --host shap-vps "$dump"
restic -r "$REPO" forget --tag shap --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-yearly 7 --prune

# Keep only the last 3 dumps on the VPS itself.
ls -1t "$STAGING"/shap-*.dump | tail -n +4 | xargs -r rm --

echo "backup ok: $stamp"
