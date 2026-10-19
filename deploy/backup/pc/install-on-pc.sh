#!/usr/bin/env bash
# Sets up this (Linux) PC to keep a copy of Shap's backups. Run as yourself, not root:
#   scp -r vps1:/opt/shap/deploy/backup/pc /tmp/shap-pc && bash /tmp/shap-pc/install-on-pc.sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
cd "$(dirname "$0")"
command -v rsync >/dev/null || { echo "Please install rsync first (e.g. sudo apt install rsync)." >&2; exit 1; }
install -D -m 0755 shap-pull.sh "$HOME/.local/bin/shap-pull.sh"
install -D -m 0644 shap-backup-pull.service "$HOME/.config/systemd/user/shap-backup-pull.service"
install -D -m 0644 shap-backup-pull.timer "$HOME/.config/systemd/user/shap-backup-pull.timer"
systemctl --user daemon-reload
systemctl --user enable --now shap-backup-pull.timer
"$HOME/.local/bin/shap-pull.sh"
echo
echo "Backups will be copied to ${SHAP_BACKUP_DEST:-$HOME/Backups/Shap} a few times a day while this PC is on."
systemctl --user list-timers shap-backup-pull.timer --no-pager | head -3
