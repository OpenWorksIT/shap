#!/usr/bin/env bash
# Copies Shap's backups from the server to this PC, so a copy lives off the server.
# Run by a systemd user timer a few times a day and soon after you log in; if the PC or the
# server is offline it simply tries again next time. Uses your normal SSH login to the server.
#   SHAP_HOST         the server (an ~/.ssh/config name or user@host)   default: vps1
#   SHAP_BACKUP_DEST  where the copies go                              default: ~/Backups/Shap
#   SHAP_KEEP_DAYS    how long the PC keeps them                       default: 365
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
HOST="${SHAP_HOST:-vps1}"
DEST="${SHAP_BACKUP_DEST:-$HOME/Backups/Shap}"
KEEP_DAYS="${SHAP_KEEP_DAYS:-365}"
mkdir -p "$DEST"
chmod 700 "$DEST"

if rsync -a --chmod=F600 --include='*.dump' --exclude='*' -e 'ssh -o BatchMode=yes -o ConnectTimeout=20' "$HOST:/var/backups/shap/" "$DEST/"; then
  # Tell the server (Settings → Updates & backups shows when the PC last took a copy).
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" 'touch /var/backups/shap/.pulled-by-pc' || true
  touch "$DEST/.last-copy"
  find "$DEST" -maxdepth 1 -name '*.dump' -mtime +"$KEEP_DAYS" -delete
  echo "Shap backups copied to $DEST"
else
  echo "Couldn't reach $HOST; will try again later." >&2
  # Only nag when it's been failing for a few days.
  if [ -z "$(find "$DEST/.last-copy" -mtime -3 2>/dev/null)" ] && command -v notify-send >/dev/null; then
    notify-send -u critical "Shap backups" "No copy from the server for 3 days. Check that you can ssh $HOST."
  fi
  exit 1
fi
