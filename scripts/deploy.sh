#!/usr/bin/env bash
# Deploy Sociafy on the box. Run this ON the EC2 host, not from your laptop.
#
# What it does:
#   1. Preflight: app dir is a git repo, tree is clean, .env.local + node + npm
#      + curl are present.
#   2. Records the current commit so it can report what changed and you can roll
#      back to it.
#   3. git pull --ff-only (branch defaults to main, --branch overrides).
#   4. npm ci  — WITH devDependencies; the build needs them.
#   5. npm run build. If the build fails it STOPS. The running site is left up.
#   6. Restarts the web process: systemd unit if there is one, else pm2, else it
#      tells you the command to run and exits non-zero.
#   7. Curls /api/health, reports database.ok and the deployed commit, and exits
#      non-zero if health is not ok.
#
# Safe to re-run. Idempotent — a re-run with nothing to pull still rebuilds and
# restarts, which is exactly what you want after a build failed halfway.
#
# Usage:
#   bash scripts/deploy.sh \
#     --dir /opt/sociafy-app \
#     --branch main \
#     --service sociafy
#
# All flags are optional — defaults are below. --dry-run prints every command it
# would run and changes nothing. --force deploys over a dirty working tree
# (local edits are kept; the pull will refuse if they conflict).
#
# Run it as the user that owns the app dir. systemctl/pm2 are invoked with sudo
# when you are not root.

set -euo pipefail

# ---------- defaults ----------
SOCIAFY_DIR="/opt/sociafy-app"
BRANCH="main"
SERVICE="sociafy"
HEALTH_URL="http://127.0.0.1:3000/api/health"
DRY_RUN="0"
FORCE="0"

# ---------- arg parse ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)         SOCIAFY_DIR="$2"; shift 2 ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    --service)     SERVICE="$2"; shift 2 ;;
    --health-url)  HEALTH_URL="$2"; shift 2 ;;
    --dry-run)     DRY_RUN="1"; shift ;;
    --force)       FORCE="1"; shift ;;
    -h|--help)
      sed -n '2,31p' "$0"
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

# Every mutating command goes through this so --dry-run is honest.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf "  \033[36m…\033[0m would run: %s\n" "$*"
  else
    "$@"
  fi
}

# systemctl and pm2 usually need root; git and npm must NOT (they'd leave
# root-owned files in the app dir).
SUDO=""
[[ "$EUID" -eq 0 ]] || SUDO="sudo"

bold "Sociafy deploy"
echo "  dir      = $SOCIAFY_DIR"
echo "  branch   = $BRANCH"
echo "  service  = $SERVICE"
echo "  health   = $HEALTH_URL"
echo "  dry-run  = $DRY_RUN"
echo "  force    = $FORCE"
echo

# ---------- 1. preflight ----------
bold "1. Preflight"

[[ -d "$SOCIAFY_DIR" ]] || fail "App dir not found: $SOCIAFY_DIR"
[[ -d "$SOCIAFY_DIR/.git" ]] || fail "$SOCIAFY_DIR is not a git checkout — nothing to pull."
cd "$SOCIAFY_DIR"

[[ -f ".env.local" ]] || fail ".env.local not found in $SOCIAFY_DIR — the build and the app both need it."

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || fail "node not found on PATH."
command -v npm >/dev/null || fail "npm not found on PATH."
command -v curl >/dev/null || fail "curl not found on PATH — needed for the health check."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  fail "checked out '$CURRENT_BRANCH', want '$BRANCH'. Switch first: git -C $SOCIAFY_DIR checkout $BRANCH"
fi

DIRTY="$(git status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  if [[ "$FORCE" == "1" ]]; then
    warn "working tree is dirty — continuing because --force was passed:"
    git status --short | sed 's/^/      /'
  else
    git status --short | sed 's/^/      /'
    fail "working tree is dirty. Commit, stash, or re-run with --force."
  fi
fi

ok "preflight checks pass (node $("$NODE_BIN" --version))"

# ---------- 2. record where we are ----------
bold "2. Current revision"
BEFORE="$(git rev-parse HEAD)"
echo "  $(git --no-pager log -1 --format='%h  %ad  %s' --date=short)"
ok "recorded $BEFORE"

# ---------- 3. pull ----------
bold "3. Pull origin/$BRANCH"
run git pull --ff-only origin "$BRANCH"

AFTER="$(git rev-parse HEAD)"
if [[ "$AFTER" == "$BEFORE" ]]; then
  # Not a no-op: the last deploy may have died in the build, so the box can be
  # "on the right commit" while serving the previous build. Rebuild anyway.
  warn "already at $(git rev-parse --short HEAD) — nothing pulled. Rebuilding anyway."
else
  ok "$(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
  echo
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'
  echo
  # These are only picked up by re-running install-cron.sh, which this script
  # deliberately does not do (it needs root and restarts cron).
  if ! git diff --quiet "$BEFORE" "$AFTER" -- etc/cron.d/sociafy scripts/cron-run.mjs; then
    warn "the cron schedule changed — re-run: sudo bash $SOCIAFY_DIR/scripts/install-cron.sh"
  fi
fi

# ---------- 4. dependencies ----------
bold "4. npm ci"
# No --omit=dev here. install-cron.sh suggests that flag for the cron user, which
# is right — cron only imports lib/cron/*.ts. But `next build` needs typescript,
# eslint and the type packages, all devDependencies, so omitting them here fails
# the build.
run npm ci

# ---------- 5. build ----------
bold "5. npm run build"
if ! run npm run build; then
  echo
  printf "\033[1;31m%s\033[0m\n" "BUILD FAILED — NOTHING WAS RESTARTED."
  echo "  The running site is untouched and still serving the previous build."
  echo "  Fix the build, then re-run: bash scripts/deploy.sh"
  echo "  To go back to where you started:"
  echo "    git -C $SOCIAFY_DIR reset --hard $BEFORE && bash $SOCIAFY_DIR/scripts/deploy.sh --force"
  exit 1
fi
ok "build succeeded"

# ---------- 6. restart ----------
bold "6. Restart web process"
RESTART_CMD=""
if command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
  RESTART_CMD="$SUDO systemctl restart $SERVICE"
elif command -v pm2 >/dev/null && pm2 describe "$SERVICE" >/dev/null 2>&1; then
  RESTART_CMD="pm2 restart $SERVICE --update-env"
elif command -v pm2 >/dev/null; then
  warn "pm2 is installed but has no process named '$SERVICE'"
fi

if [[ -z "$RESTART_CMD" ]]; then
  # Claiming success here is how a deploy "succeeds" while the box serves the
  # old build. Say what to run and get out.
  printf "\033[1;31m%s\033[0m\n" "NO PROCESS MANAGER DETECTED — THE NEW BUILD IS NOT SERVING YET."
  echo "  Built commit $(git rev-parse --short HEAD) is on disk but nothing was restarted."
  echo "  Restart it yourself with whichever applies:"
  echo "    sudo systemctl restart $SERVICE       # if it runs under systemd (pass --service <unit>)"
  echo "    pm2 restart <name> --update-env       # if it runs under pm2"
  echo "    # then re-check:  curl -s $HEALTH_URL"
  exit 1
fi

# Unquoted on purpose: RESTART_CMD is a command line, and $SUDO may be empty.
# shellcheck disable=SC2086
run $RESTART_CMD
ok "restarted via: $RESTART_CMD"

# ---------- 7. health ----------
bold "7. Health check"
if [[ "$DRY_RUN" == "1" ]]; then
  ok "dry-run — skipping $HEALTH_URL"
  echo
  bold "Dry run complete. Nothing was changed."
  exit 0
fi

# No -f: a degraded app answers 503 WITH a body, and that body is the diagnosis.
# Retry while the process boots — a fresh next start needs a few seconds.
BODY=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  BODY="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
  [[ -n "$BODY" ]] && break
  sleep 3
done
[[ -n "$BODY" ]] || fail "no response from $HEALTH_URL after ~30s — the process did not come up. Check: $SUDO journalctl -u $SERVICE -n 50"

# node, not jq: node is a hard requirement above, jq may not be installed.
HEALTHY=0
printf '%s' "$BODY" | "$NODE_BIN" -e '
let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { console.log("  unparseable health response: " + s.slice(0, 200)); process.exit(1); }
  for (const [name, c] of Object.entries(j.checks || {})) {
    console.log(`  ${name}.ok = ${!!c.ok}${c.detail ? ` (${c.detail})` : ""}`);
  }
  process.exit(j.ok ? 0 : 1);
});' || HEALTHY=1

DEPLOYED="$(git rev-parse --short HEAD)"
echo
if [[ "$HEALTHY" != "0" ]]; then
  printf "\033[1;31m%s\033[0m\n" "UNHEALTHY — deployed $DEPLOYED but /api/health is not ok."
  echo "  Logs:     $SUDO journalctl -u $SERVICE -n 50"
  echo "  Rollback: git -C $SOCIAFY_DIR reset --hard $BEFORE && bash $SOCIAFY_DIR/scripts/deploy.sh --force"
  exit 1
fi

bold "Done."
echo "  Deployed:  $DEPLOYED  $(git --no-pager log -1 --format='%s')"
echo "  Was:       $(git rev-parse --short "$BEFORE")"
echo "  Rollback:  git -C $SOCIAFY_DIR reset --hard $BEFORE && bash $SOCIAFY_DIR/scripts/deploy.sh --force"
echo "  Cron logs: ls -la /var/log/sociafy/"
