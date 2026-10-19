#!/usr/bin/env bash
# Optional: an encrypted, deduplicated off-site copy (restic) of the backups that shap-ctl makes
# every night in /var/backups/shap. Your PC's copy (pc/) is usually enough; this is for a
# second provider (an S3-compatible bucket or a storage box).
#
# Install on the VPS: copy shap-backup.service and .timer to /etc/systemd/system, set
# RESTIC_REPOSITORY in the service, then: systemctl enable --now shap-backup.timer
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

BACKUPS="${SHAP_BACKUP_DIR:-/var/backups/shap}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/root/.restic-password}"
REPO="${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (e.g. s3:https://... or sftp:user@host:/srv/backups/shap)}"

ls "$BACKUPS"/*-daily-*.dump >/dev/null 2>&1 || { echo "No backups in $BACKUPS yet (see deploy/vps/ctl)." >&2; exit 1; }
restic -r "$REPO" backup --tag shap --host shap-vps "$BACKUPS"
restic -r "$REPO" forget --tag shap --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-yearly 7 --prune
echo "off-site backup ok"
