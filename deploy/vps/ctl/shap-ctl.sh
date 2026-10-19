#!/usr/bin/env bash
# Shap's hands on the server. Runs as root on the VPS, started by systemd:
#   - when Settings → System in the app asks (it writes a request file: check, update or backup)
#   - every night (backup, then check for updates)
# The app itself never gets Docker or root: it can only leave a note and read the status.
#
#   shap-ctl.sh [check|update|backup|nightly]     (no argument: read the app's request)
# SPDX-License-Identifier: AGPL-3.0-or-later

main() {
  set -uo pipefail
  REPO="${SHAP_REPO:-/opt/shap}"
  VPS="$REPO/deploy/vps"
  CTL="${SHAP_CTL_DIR:-/var/lib/shap/ctl}"
  BACKUPS="${SHAP_BACKUP_DIR:-/var/backups/shap}"
  KEEP_DAILY="${SHAP_KEEP_DAILY:-14}"
  APP_GID="${SHAP_APP_GID:-1000}"
  mkdir -p "$CTL" "$BACKUPS"

  # One at a time. A request left waiting is picked up when the running job ends.
  exec 9>/run/shap-ctl.lock
  flock -n 9 || { echo "shap-ctl is already running"; return 0; }

  local action="${1:-}"
  if [ -z "$action" ]; then
    action="$(tr -dc 'a-z-' < "$CTL/request" 2>/dev/null || true)"
    rm -f "$CTL/request"
    [ -n "$action" ] || action=check
  fi

  case "$action" in
    check) check ;;
    update) update ;;
    backup) backup manual ;;
    nightly) backup daily; check ;;
    *) echo "Unknown action: $action"; return 1 ;;
  esac
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# status.json, read by the app. Keys are merged so each step only changes its own part.
put() { # put KEY JSON
  local f="$CTL/status.json" tmp
  tmp="$(mktemp "$CTL/.status.XXXXXX")"
  if [ -s "$f" ] && jq -e . "$f" >/dev/null 2>&1; then jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$f" > "$tmp"
  else jq -n --arg k "$1" --argjson v "$2" '{($k): $v}' > "$tmp"; fi
  chmod 644 "$tmp" && mv -f "$tmp" "$f"
}

check() {
  put checking "$(jq -n --arg at "$(now)" '{at: $at}')"
  local err=""
  git -C "$REPO" fetch -q origin main 2>"$CTL/.fetch.err" || err="$(tail -c 400 "$CTL/.fetch.err")"
  local cur latest
  cur="$(git -C "$REPO" rev-parse HEAD)"
  latest="$(git -C "$REPO" rev-parse origin/main 2>/dev/null || echo "$cur")"
  jq -n \
    --arg at "$(now)" --arg err "$err" \
    --arg cur "$cur" --arg curVersion "$(jq -r .version "$REPO/package.json")" \
    --arg curDate "$(git -C "$REPO" log -1 --format=%cI HEAD)" \
    --arg latest "$latest" --arg latestVersion "$(git -C "$REPO" show origin/main:package.json 2>/dev/null | jq -r .version 2>/dev/null || echo '')" \
    --arg latestDate "$(git -C "$REPO" log -1 --format=%cI "$latest")" \
    --argjson behind "$(git -C "$REPO" rev-list --count HEAD.."$latest" 2>/dev/null || echo 0)" \
    --argjson changes "$(git -C "$REPO" log --format='%h%x09%s' HEAD.."$latest" 2>/dev/null | head -40 | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {sha: .[0], subject: .[1]})')" \
    --arg changelog "$(git -C "$REPO" show "$latest":CHANGELOG.md 2>/dev/null | head -c 12000)" \
    '{at: $at, error: $err, current: {sha: $cur, version: $curVersion, date: $curDate}, latest: {sha: $latest, version: $latestVersion, date: $latestDate}, behind: $behind, changes: $changes, changelog: $changelog}' \
    > "$CTL/.check.json"
  put check "$(cat "$CTL/.check.json")"
  put checking null
  rm -f "$CTL/.check.json" "$CTL/.fetch.err"
}

backup() { # backup daily|manual|pre-update
  local kind="$1" stamp dbs db ok=true out
  stamp="$(date +%Y-%m-%d_%H%M)"
  put backingUp "$(jq -n --arg at "$(now)" '{at: $at}')"
  install -d -m 0750 -o root -g "$APP_GID" "$BACKUPS"
  cd "$VPS" || return 1
  dbs="$(docker compose exec -T db psql -U shap -d postgres -Atc "select datname from pg_database where datname = 'shap' or datname like 'shap\_%' order by 1")" || ok=false
  for db in $dbs; do
    out="$BACKUPS/$db-$kind-$stamp.dump"
    if docker compose exec -T db pg_dump -U shap -d "$db" -Fc > "$out.part" && docker compose exec -T db pg_restore --list < "$out.part" > /dev/null; then
      mv -f "$out.part" "$out"
      chgrp "$APP_GID" "$out" && chmod 640 "$out"
    else
      ok=false; rm -f "$out.part"
    fi
  done
  # Keep the last $KEEP_DAILY nightly backups and the last 5 of the others, per database.
  for db in $dbs; do
    ls -1t "$BACKUPS/$db"-daily-*.dump 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | xargs -r rm -f --
    ls -1t "$BACKUPS/$db"-manual-*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f --
    ls -1t "$BACKUPS/$db"-pre-update-*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f --
  done
  put backup "$(jq -n --arg at "$(now)" --arg kind "$kind" --argjson ok "$ok" '{at: $at, kind: $kind, ok: $ok}')"
  put backingUp null
  $ok
}

update() {
  put updating "$(jq -n --arg at "$(now)" '{at: $at, step: "Backing up first"}')"
  local from log="$CTL/update.log" ok=true
  from="$(git -C "$REPO" rev-parse --short HEAD)"
  : > "$log"
  if ! backup pre-update >> "$log" 2>&1; then
    put lastUpdate "$(jq -n --arg at "$(now)" '{at: $at, ok: false, message: "The backup before updating failed, so nothing was changed."}')"
    put updating null
    return 1
  fi
  put updating "$(jq -n --arg at "$(now)" '{at: $at, step: "Fetching the new version"}')"
  git -C "$REPO" pull --ff-only -q origin main >> "$log" 2>&1 || ok=false
  if $ok; then
    put updating "$(jq -n --arg at "$(now)" '{at: $at, step: "Building and restarting (a few minutes)"}')"
    cd "$VPS" && GIT_SHA="$(git -C "$REPO" rev-parse --short HEAD)" docker compose up -d --build >> "$log" 2>&1 || ok=false
  fi
  if $ok; then
    # Wait for Shap to come back healthy.
    ok=false
    for _ in $(seq 1 60); do
      if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null)" = healthy ]; then ok=true; break; fi
      sleep 5
    done
  fi
  local to; to="$(git -C "$REPO" rev-parse --short HEAD)"
  put lastUpdate "$(jq -n --arg at "$(now)" --argjson ok "$ok" --arg from "$from" --arg to "$to" --arg version "$(jq -r .version "$REPO/package.json")" \
    --arg tail "$(tail -c 3000 "$log")" '{at: $at, ok: $ok, from: $from, to: $to, version: $version, log: $tail}')"
  put updating null
  docker image prune -f > /dev/null 2>&1 || true
  check
}

main "$@"
exit $?
