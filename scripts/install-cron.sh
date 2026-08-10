#!/usr/bin/env bash
# Install Sociafy's scheduled jobs into the system crontab.
#
# What it does:
#   1. Validates the app dir exists, has .env.local, and node + npm deps are present.
#   2. Creates /var/log/sociafy (or wherever LOG_DIR points) with the right owner.
#   3. Renders etc/cron.d/sociafy with your local values for user/dir/node and
#      installs it to /etc/cron.d/sociafy with 0644 perms (required by cron).
#   4. Validates the cron file syntax and restarts cron.
#   5. Smoke-tests one cron task so you see output before the first scheduled run.
#
# Safe to re-run. Idempotent.
#
# Usage:
#   sudo bash scripts/install-cron.sh \
#     --dir /opt/sociafy-app \
#     --user sociafy \
#     --node "$(command -v node)"
#
# All three flags are optional — defaults are below. Run with --dry-run to
# preview the rendered cron file without installing.

set -euo pipefail

# ---------- defaults ----------
SOCIAFY_DIR="/opt/sociafy-app"
SOCIAFY_USER="sociafy"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
LOG_DIR="/var/log/sociafy"
CRON_DEST="/etc/cron.d/sociafy"
DRY_RUN="0"

# ---------- arg parse ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      SOCIAFY_DIR="$2"; shift 2 ;;
    --user)     SOCIAFY_USER="$2"; shift 2 ;;
    --node)     NODE_BIN="$2"; shift 2 ;;
    --log-dir)  LOG_DIR="$2"; shift 2 ;;
    --cron)     CRON_DEST="$2"; shift 2 ;;
    --dry-run)  DRY_RUN="1"; shift ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail()  { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

bold "Sociafy cron install"
echo "  dir      = $SOCIAFY_DIR"
echo "  user     = $SOCIAFY_USER"
echo "  node     = $NODE_BIN"
echo "  log dir  = $LOG_DIR"
echo "  cron     = $CRON_DEST"
echo "  dry-run  = $DRY_RUN"
echo

# ---------- preflight ----------
bold "1. Preflight"

[[ "$EUID" -eq 0 ]] || fail "Run with sudo — this script writes to /etc/cron.d and /var/log."
[[ -d "$SOCIAFY_DIR" ]] || fail "App dir not found: $SOCIAFY_DIR"
[[ -f "$SOCIAFY_DIR/package.json" ]] || fail "No package.json in $SOCIAFY_DIR — is this the right --dir?"
[[ -f "$SOCIAFY_DIR/.env.local" ]] || warn ".env.local not found in $SOCIAFY_DIR — cron tasks will fail without DATABASE_URL etc."
[[ -x "$NODE_BIN" ]] || fail "node binary not executable: $NODE_BIN"
[[ -f "$SOCIAFY_DIR/scripts/cron-run.mjs" ]] || fail "Missing scripts/cron-run.mjs — repo out of date?"

# tsx must be installed (cron-run.mjs uses it to load lib/cron/*.ts).
if [[ ! -d "$SOCIAFY_DIR/node_modules/tsx" ]]; then
  fail "node_modules/tsx is missing. Run 'npm ci --omit=dev' in $SOCIAFY_DIR first."
fi
ok "preflight checks pass"

# ---------- ensure user ----------
bold "2. User account"
if id "$SOCIAFY_USER" &>/dev/null; then
  ok "user '$SOCIAFY_USER' exists"
else
  warn "user '$SOCIAFY_USER' does not exist — creating system account"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SOCIAFY_USER"
  ok "created user '$SOCIAFY_USER'"
fi

# ---------- log dir ----------
bold "3. Log directory"
mkdir -p "$LOG_DIR"
chown "$SOCIAFY_USER:$SOCIAFY_USER" "$LOG_DIR"
chmod 0755 "$LOG_DIR"
ok "$LOG_DIR ready"

# ---------- render cron file ----------
bold "4. Rendering cron file"
TEMPLATE="$SOCIAFY_DIR/etc/cron.d/sociafy"
[[ -f "$TEMPLATE" ]] || fail "Missing template: $TEMPLATE"

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

# Substitute the env-style placeholders the template uses. We do this with
# sed (not cron's own SHELL=...) so the installed file is fully resolved and
# you can `cat /etc/cron.d/sociafy` to see exactly what runs.
#
# The [$]SOCIAFY_USER pass is not cosmetic: cron parses the user column itself,
# BEFORE any shell sees the line, so it never expands a variable there — an
# unsubstituted "$SOCIAFY_USER" is an unknown username and the entry silently
# never runs. ($SOCIAFY_DIR / $LOG_DIR inside the command are fine; SHELL
# expands those.) Ordered after the assignment rewrite above, which matches on
# "^SOCIAFY_USER=" and so is untouched by this one.
sed \
  -e "s|^SOCIAFY_USER=.*|SOCIAFY_USER=$SOCIAFY_USER|" \
  -e "s|^SOCIAFY_DIR=.*|SOCIAFY_DIR=$SOCIAFY_DIR|" \
  -e "s|^NODE_BIN=.*|NODE_BIN=$NODE_BIN|" \
  -e "s|^LOG_DIR=.*|LOG_DIR=$LOG_DIR|" \
  -e "s|[$]SOCIAFY_USER|$SOCIAFY_USER|g" \
  "$TEMPLATE" > "$RENDERED"

if [[ "$DRY_RUN" == "1" ]]; then
  bold "5. Dry-run — would write the following to $CRON_DEST:"
  echo "------------------------------------------------------------"
  cat "$RENDERED"
  echo "------------------------------------------------------------"
  ok "dry-run complete — nothing installed"
  exit 0
fi

install -m 0644 "$RENDERED" "$CRON_DEST"
ok "installed $CRON_DEST (mode 0644)"

# ---------- restart cron ----------
bold "5. Reload cron"
# Try systemd first, fall back to sysvinit.
if command -v systemctl &>/dev/null && systemctl list-unit-files | grep -qE '^(cron|cronie|crond)\.service'; then
  for svc in cron cronie crond; do
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
      systemctl reload "$svc" 2>/dev/null || systemctl restart "$svc"
      ok "reloaded $svc via systemd"
      break
    fi
  done
elif command -v service &>/dev/null; then
  service cron reload 2>/dev/null || service cron restart || warn "couldn't reload cron — restart manually"
  ok "reloaded cron via service"
else
  warn "no systemctl/service found — restart cron manually"
fi

# ---------- smoke test ----------
bold "6. Smoke test (refresh-tokens, dry on empty DB is fast)"
if sudo -u "$SOCIAFY_USER" -H bash -c "cd '$SOCIAFY_DIR' && '$NODE_BIN' scripts/cron-run.mjs refresh-tokens" 2>&1 | tail -20; then
  ok "refresh-tokens ran cleanly as $SOCIAFY_USER"
else
  warn "smoke test failed — check the output above. Common causes: missing env vars, wrong NODE_BIN, .env.local not readable by $SOCIAFY_USER"
fi

echo
bold "Done."
echo "  Schedule:   crontab -l -u $SOCIAFY_USER  (system cron, not user — view with: cat $CRON_DEST)"
echo "  Logs:       ls -la $LOG_DIR/"
echo "  Next runs:  systemctl status cron  (or 'grep CRON /var/log/syslog')"
