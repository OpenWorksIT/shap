#!/usr/bin/env bash
# One-time setup on the VPS: lets Settings → System in the app check for updates, update,
# and back up, and backs up every night at 02:30. Run again after it changes (harmless).
#   sudo /opt/shap/deploy/vps/ctl/install.sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
cd "$(dirname "$0")"
command -v jq >/dev/null && command -v rsync >/dev/null || apt-get install -y jq rsync
# The app runs as user 1000 (node) in its container. It READS shap-ctl's status and the backups,
# and WRITES only its one request file — and these must be kept apart, or a compromised app could
# plant a symlink where root writes and have root write through it (root escalation).
#   - ctl: root-only (0755). Root writes status.json etc.; the app mounts it read-only.
#   - ctl-in: the app's drop-box (root:1000, sticky 1730). The app creates its request here; the
#     sticky bit stops it replacing or removing anything else.
#   - backups: read-only to the app (0750, group 1000).
install -d -m 0755 -o root -g root /var/lib/shap/ctl
install -d -m 1730 -o root -g 1000 /var/lib/shap/ctl-in
install -d -m 0750 -o root -g 1000 /var/backups/shap
install -m 0644 shap-ctl.path shap-ctl.service shap-nightly.service shap-nightly.timer shap-audit.service shap-audit.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shap-ctl.path shap-nightly.timer shap-audit.timer
# Mount the folders into the app (the compose file already names them) and take a first look.
cd .. && docker compose up -d
/opt/shap/deploy/vps/ctl/shap-ctl.sh check || true
echo "Done. Settings → System in Shap now shows the version, updates and backups."
