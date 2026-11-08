#!/usr/bin/env bash
# A read-only security and privacy check of a Shap server (the VPS set up with deploy/vps). It
# changes nothing; each line is OK, WARN (worth a look) or FAIL (put it right). Based on Steady's.
#
#   sudo ./audit-server.sh                     # on screen
#   sudo ./audit-server.sh --quiet --json /var/lib/shap/ctl/audit.json
#                                              # what the shap-audit timer runs every 6 hours: the
#                                              # results go where the app reads them (Settings →
#                                              # Updates & backups → Checks)
#
# Covers: SSH, the firewall and what listens on the network (the database and the app never on
# the internet), automatic security updates and waiting reboots, disk space, who may change
# Shap's code and read its secrets and backups, the containers (not root, no extra powers, no
# ports of their own), backups (recent, readable, not readable by others), each site from outside
# (HTTPS certificate, redirect, security headers, nothing revealing), and Shap's own settings
# (two-step sign-in required and in use, an update waiting).
#
# The books themselves are checked inside each company's Shap (Settings → Updates & backups →
# The books, audit/books.ts): this file holds nothing of any company's figures, so every
# company on the server can be shown it.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
cd "$(dirname "$0")" || exit 1

QUIET=no; JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON="${2:-}"; [ -n "$JSON" ] || { echo "--json needs a file" >&2; exit 2; }; shift 2 ;;
    --quiet) QUIET=yes; shift ;;
    *) echo "usage: audit-server.sh [--quiet] [--json FILE]" >&2; exit 2 ;;
  esac
done

RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS" "$RESULTS.json"' EXIT
SECTION=""
say()  { [ "$QUIET" = yes ] || printf "$@"; }
rec()  { printf '%s\t%s\t%s\n' "$1" "$SECTION" "$(printf '%s' "$2" | tr '\t\n' '  ')" >> "$RESULTS"; }
ok()   { say '  OK    %s\n' "$*"; rec ok "$*"; }
warn() { say '  WARN  %s\n' "$*"; rec warn "$*"; }
fail() { say '  FAIL  %s\n' "$*"; rec fail "$*"; }
head_() { say '\n%s\n' "$*"; SECTION="$*"; }
envv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

REPO="$(cd ../.. && pwd)"
CTL=/var/lib/shap/ctl
BACKUPS=/var/backups/shap
DOMAIN="$(envv SHAP_DOMAIN)"
[ "$(id -u)" = 0 ] || say '%s\n' "(not root: some checks will be skipped)"
dc() { docker compose "$@" 2>/dev/null; }

head_ "SSH"
if command -v sshd >/dev/null; then
  cfg="$(sshd -T 2>/dev/null)"
  grep -qi '^passwordauthentication no' <<<"$cfg" && ok "passwords can't be used to sign in" || fail "SSH accepts passwords: set PasswordAuthentication no"
  grep -qi '^kbdinteractiveauthentication no' <<<"$cfg" && ok "no keyboard-interactive sign-in" || warn "KbdInteractiveAuthentication isn't off"
  case "$(grep -i '^permitrootlogin' <<<"$cfg" | awk '{print $2}')" in
    no) ok "root can't sign in over SSH" ;;
    prohibit-password|without-password) warn "root signs in over SSH with a key: a named user with sudo is better" ;;
    *) fail "root can sign in over SSH with a password" ;;
  esac
else
  warn "sshd not found (skipped)"
fi

head_ "Firewall and what listens"
if command -v ufw >/dev/null && ufw status verbose 2>/dev/null | grep -q 'Status: active'; then
  ufw status verbose 2>/dev/null | grep -q 'Default: deny (incoming)\|Default: reject (incoming)' \
    && ok "ufw is on and refuses incoming connections by default" || fail "ufw is on but lets incoming connections in by default: ufw default deny incoming"
elif command -v nft >/dev/null && nft list ruleset 2>/dev/null | grep -Eq 'hook input .*policy (drop|reject)'; then
  ok "nftables drops incoming connections unless a rule allows them"
elif command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | head -1 | grep -Eq '^-P INPUT (DROP|REJECT)'; then
  ok "iptables drops incoming connections unless a rule allows them"
else
  fail "no firewall drops incoming connections (Docker's own rules don't count): ufw default deny incoming"
fi
if command -v ss >/dev/null; then
  open="$(ss -Htlnu 2>/dev/null | awk '{print $5}' | grep -vE '^(127\.|\[::1\]|::1)' | sed 's/.*://' | sort -un | tr '\n' ' ')"
  bad=""
  for p in $open; do case "$p" in 22|80|443) ;; 5432|8080) bad="$bad $p" ;; esac; done
  [ -z "$bad" ] && ok "the database and the app aren't reachable from outside (open: ${open:-none})" || fail "reachable from outside:$bad (the database or the app must sit behind Caddy only)"
  extra="$(for p in $open; do case "$p" in 22|80|443|5432|8080) ;; *) printf '%s ' "$p" ;; esac; done)"
  [ -z "$extra" ] && ok "nothing else listens on the network" || warn "also listening: $extra(is each one meant to be there?)"
fi

head_ "Updates"
if [ -f /etc/apt/apt.conf.d/20auto-upgrades ] && grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then
  ok "security updates install themselves (unattended-upgrades)"
else
  fail "automatic security updates are off: apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"
fi
[ -f /var/run/reboot-required ] && warn "a reboot is waiting to finish installing updates (outside working hours)" || ok "no reboot waiting"

head_ "Disk"
free="$(df -P / | awk 'NR==2 {print 100 - $5}' | tr -d '%')"
if [ "${free:-0}" -lt 5 ]; then fail "only ${free}% of the disk is free: backups and updates will fail"
elif [ "${free:-0}" -lt 20 ]; then warn "${free}% of the disk is free"
else ok "${free}% of the disk is free"; fi

head_ "Files"
# root runs this code (the updater, the backups): nobody else may change it
own="$(stat -c '%U' "$REPO" 2>/dev/null)"
writable="$(find "$REPO" -path "$REPO/node_modules" -prune -o -path "$REPO/.git" -prune -o \( -perm -o+w -o -perm -g+w \) -type f -print 2>/dev/null | head -3 | tr '\n' ' ')"
[ "$own" = root ] && ok "Shap's code belongs to root" || warn "Shap's code ($REPO) belongs to $own, not root: whoever that is can change what root runs"
[ -z "$writable" ] && ok "nobody else can change Shap's code" || fail "others can change Shap's code: $writable"
if [ -f .env ]; then
  mode="$(stat -c '%a %U' .env)"
  [ "$mode" = "600 root" ] && ok ".env (passwords, keys) is readable only by root" || fail ".env is $mode: chmod 600 .env && chown root .env"
  [ -n "$(envv SECRETS_KEY)" ] && ok "a secrets key is set (two-step sign-in secrets are encrypted)" || fail "SECRETS_KEY isn't set in .env"
  [ -n "$(envv POSTGRES_PASSWORD)" ] && ok "the database has its own password" || fail "POSTGRES_PASSWORD isn't set in .env"
else
  fail "no .env next to docker-compose.yml"
fi
[ "$(stat -c '%a %U' "$CTL" 2>/dev/null)" = "755 root" ] && ok "the updater's state is root's alone (the app only reads it)" || warn "$CTL isn't 755 root (ctl/install.sh sets it)"
case "$(stat -c '%a' "$BACKUPS" 2>/dev/null)" in
  750|700) ok "backups can't be read by other users on the server" ;;
  "") warn "no backup folder at $BACKUPS" ;;
  *) fail "$BACKUPS is $(stat -c '%a' "$BACKUPS"): chmod 750 (backups hold every company's books)" ;;
esac
loose="$(find "$BACKUPS" -name '*.dump' -perm -o+r 2>/dev/null | head -3 | tr '\n' ' ')"
[ -z "$loose" ] && ok "no backup file is readable by everyone" || fail "backup files readable by everyone: $loose"

head_ "Containers"
if command -v docker >/dev/null && dc ps -q app >/dev/null; then
  apps="$(docker ps --filter label=com.docker.compose.project=shap --format '{{.Names}}' | grep -i app)"
  for c in $apps; do
    user="$(docker inspect -f '{{.Config.User}}' "$c" 2>/dev/null)"
    [ -n "$user" ] && [ "$user" != root ] && [ "$user" != 0 ] && ok "$c runs as '$user', not root" || fail "$c runs as root"
    sec="$(docker inspect -f '{{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}} {{.HostConfig.Privileged}}' "$c" 2>/dev/null)"
    grep -q 'no-new-privileges' <<<"$sec" && grep -qi 'all' <<<"$sec" && ok "$c has no extra powers (no-new-privileges, all capabilities dropped)" || warn "$c keeps powers it doesn't need: $sec"
    grep -q ' true$' <<<"$sec" && fail "$c is privileged" || true
  done
  published="$(docker ps --filter label=com.docker.compose.project=shap --format '{{.Names}} {{.Ports}}' | grep -v caddy | grep -E '0\.0\.0\.0|:::' || true)"
  [ -z "$published" ] && ok "only Caddy takes connections from outside" || fail "containers with ports of their own: $published"
  health="$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q app)" 2>/dev/null)"
  [ "$health" = healthy ] && ok "Shap is up and healthy" || fail "Shap isn't healthy ($health): docker compose logs app"
else
  fail "Shap's containers aren't running (docker compose ps)"
fi

head_ "Backups"
newest="$(ls -1t "$BACKUPS"/shap-daily-*.dump 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  fail "no nightly backup yet ($BACKUPS): is the shap-nightly timer on? systemctl status shap-nightly.timer"
else
  age=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
  [ "$age" -le 36 ] && ok "last night's backup is there ($age hours old)" || fail "the newest backup is $age hours old: systemctl status shap-nightly.timer"
  [ "$(stat -c %s "$newest")" -gt 10000 ] && ok "it isn't empty ($(du -h "$newest" | cut -f1))" || fail "the newest backup is suspiciously small: $newest"
  n="$(ls -1 "$BACKUPS"/shap-daily-*.dump 2>/dev/null | wc -l)"
  [ "$n" -ge 7 ] && ok "$n nightly backups kept" || warn "only $n nightly backups so far"
fi
# deploy/backup on your PC touches this file each time it copies the backups off the server
if [ -f "$BACKUPS/.pulled-by-pc" ]; then
  pulled=$(( ($(date +%s) - $(stat -c %Y "$BACKUPS/.pulled-by-pc")) / 86400 ))
  [ "$pulled" -le 8 ] && ok "a copy reached your own computer $pulled days ago" || warn "the backups were last copied off the server $pulled days ago (deploy/backup on your PC)"
else
  warn "no backup has been copied off the server yet (deploy/backup on your PC): a backup on the same server isn't safe from losing the server"
fi

head_ "Each site from outside"
[ -n "$DOMAIN" ] || warn "no SHAP_DOMAIN in .env: the site wasn't checked from outside"
sites="$DOMAIN $(grep -h -oE '^[a-z0-9.-]+\.[a-z]{2,}' sites/*.caddy 2>/dev/null | sort -u | tr '\n' ' ')"
for d in $sites; do
  [ -n "$d" ] || continue
  if ! command -v curl >/dev/null; then warn "curl isn't installed (skipped $d)"; continue; fi
  hdr="$(curl -sS -m 15 -D - -o /dev/null "https://$d/" 2>/dev/null)"
  if [ -z "$hdr" ]; then fail "$d doesn't answer over HTTPS"; continue; fi
  end="$(echo | openssl s_client -connect "$d:443" -servername "$d" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -n "$end" ]; then
    days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    [ "$days" -ge 14 ] && ok "$d: certificate good for $days more days" || fail "$d: the certificate runs out in $days days"
  fi
  redirect="$(curl -sS -m 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$d/" 2>/dev/null)"
  grep -qE '^30[18] https://' <<<"$redirect" && ok "$d: plain HTTP goes to HTTPS" || warn "$d: plain HTTP doesn't send people to HTTPS ($redirect)"
  grep -qi '^strict-transport-security:' <<<"$hdr" && ok "$d: browsers are told to use HTTPS only (HSTS)" || fail "$d: no Strict-Transport-Security"
  for h in content-security-policy x-content-type-options referrer-policy; do
    grep -qi "^$h:" <<<"$hdr" || fail "$d: no $h header"
  done
  grep -qiE '^(server: .*[0-9]|x-powered-by:)' <<<"$hdr" && warn "$d: says what it runs on (Server/X-Powered-By)" || ok "$d: security headers in place, nothing revealing"
  health="$(curl -sS -m 10 "https://$d/api/health" 2>/dev/null)"
  grep -q '"ok":true' <<<"$health" && ok "$d: Shap answers" || fail "$d: /api/health doesn't answer"
done

head_ "Shap's own settings"
mfa="$(envv MFA_REQUIRED)"
[ "${mfa:-true}" = true ] && ok "everyone must use two-step sign-in" || warn "two-step sign-in isn't required (MFA_REQUIRED=$mfa in .env)"
if dc ps -q db >/dev/null; then
  nomfa="$(dc exec -T db psql -U shap -d shap -Atc "select count(*) from users where active and role = 'owner' and totp_enabled_at is null" 2>/dev/null)"
  [ "${nomfa:-0}" = 0 ] && ok "every owner uses two-step sign-in" || warn "$nomfa owner accounts don't use two-step sign-in yet"
fi
behind="$(jq -r '.check.behind // 0' "$CTL/status.json" 2>/dev/null)"
[ "${behind:-0}" = 0 ] && ok "Shap is on the newest checked version" || warn "an update is waiting ($behind changes): Settings → Updates & backups"
systemctl is-active -q shap-nightly.timer 2>/dev/null && ok "nightly backups and update checks are on" || fail "the nightly timer is off: systemctl enable --now shap-nightly.timer"

FAILS="$(grep -c '^fail' "$RESULTS")"; WARNS="$(grep -c '^warn' "$RESULTS")"
say '\n%d to fix, %d to look at.\n' "$FAILS" "$WARNS"

if [ -n "$JSON" ]; then
  python3 - "$RESULTS" "$RESULTS.json" "$(hostname)" "$(jq -r .version "$REPO/package.json" 2>/dev/null)" "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)" <<'PY' && install -m 644 "$RESULTS.json" "$JSON"
import datetime, json, sys
src, dst, host, version, code = sys.argv[1:6]
items = []
for line in open(src, encoding="utf-8", errors="replace"):
    parts = line.rstrip("\n").split("\t", 2)
    if len(parts) == 3 and parts[0] in ("ok", "warn", "fail"):
        items.append({"level": parts[0], "section": parts[1][:60], "text": parts[2].strip()[:300]})
json.dump({
    "format": 1, "kind": "server",
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "host": host[:80], "version": version[:40], "code": code[:40],
    "fails": sum(i["level"] == "fail" for i in items),
    "warns": sum(i["level"] == "warn" for i in items),
    "oks": sum(i["level"] == "ok" for i in items),
    "items": items[:300],
}, open(dst, "w"))
PY
fi
[ "$FAILS" -eq 0 ]
