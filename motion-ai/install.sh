#!/usr/bin/env bash
# Rootless, idempotent install of the motion-ai worker on the L40S box (runs as `ubuntu`).
# Called by deploy.sh after it has rsynced this folder to $BASE/app.
# ponytail: no sudo on the box, so no dedicated `motionai` user / system unit; isolation is a
# bwrap sandbox around every job step instead (see server.mjs). With root, add the user and
# move BASE to /srv/motionai.
set -euo pipefail
BASE=${BASE:-$HOME/motionai}
HF=hyperframes@0.8.141
CHROME=152.0.7977.30
mkdir -p "$BASE"/{bin,jobs,tmp,home/.claude/skills,home/.local/share/fonts}
cd "$BASE"

# Node 22
if [ ! -x node/bin/node ]; then
  tgz=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v22[^ ]*-linux-x64.tar.xz' | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$tgz" | tar -xJ -C tmp
  mv "tmp/${tgz%.tar.xz}" node
fi
export PATH="$BASE/node/bin:$PATH"

# Chrome headless shell, fetched directly (`hyperframes browser ensure` hangs)
if [ ! -x chrome/chrome-headless-shell ]; then
  curl -fsSL -o tmp/chs.zip "https://storage.googleapis.com/chrome-for-testing-public/$CHROME/linux64/chrome-headless-shell-linux64.zip"
  python3 -m zipfile -e tmp/chs.zip tmp/ && rm tmp/chs.zip
  mv tmp/chrome-headless-shell-linux64 chrome && chmod -R u+x chrome
fi

# Pinned renderer, shared by every job via a node_modules symlink
[ -d hf/node_modules/hyperframes ] || npm i --prefix hf --no-audit --no-fund "$HF"

# Noto fonts as user fonts (no apt install without root)
if [ ! -f home/.local/share/fonts/.noto ]; then
  (cd tmp && apt-get download fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && for d in *.deb; do dpkg-deb -x "$d" x; done \
    && cp -r x/usr/share/fonts/* "$BASE/home/.local/share/fonts/" && rm -rf x ./*.deb)
  HOME="$BASE/home" fc-cache -f >/dev/null && touch home/.local/share/fonts/.noto
fi

# Pinned copy of the Claude Code binary (bound read-only into the sandbox)
cp -f "$(readlink -f "$HOME/.local/bin/claude")" bin/claude
# The one audio CLI Claude may run (ElevenLabs; key comes in via env per job)
install -m 755 app/motion-audio.mjs bin/motion-audio

# Subscription token copy, readable only by us
install -m 600 "$HOME/.claude-oauth-token" oauth-token

# Engine secret (once); R2 vars are appended by deploy.sh
touch .env && chmod 600 .env
grep -q '^ENGINE_SECRET=' .env || echo "ENGINE_SECRET=$(openssl rand -hex 32)" >> .env
grep -q '^MOTIONAI_BASE=' .env || echo "MOTIONAI_BASE=$BASE" >> .env

# /motion-graphics workflow skill (best effort)
HOME="$BASE/home" HYPERFRAMES_NO_TELEMETRY=1 timeout 120 \
  "$BASE/hf/node_modules/.bin/hyperframes" skills update motion-graphics </dev/null >/dev/null 2>&1 || true

# systemd --user service (linger is enabled for ubuntu)
mkdir -p "$HOME/.config/systemd/user"
sed "s#@BASE@#$BASE#g" app/motionai.service > "$HOME/.config/systemd/user/motionai.service"
systemctl --user daemon-reload
systemctl --user enable motionai.service >/dev/null 2>&1
systemctl --user restart motionai.service

# Reverse tunnel to prod (the security group blocks inbound 8790). The pubkey must be in prod's
# authorized_keys with the restrictions shown in README.md before this can connect.
[ -f "$HOME/.ssh/motionai_tunnel" ] || ssh-keygen -q -t ed25519 -N "" -C motionai-tunnel -f "$HOME/.ssh/motionai_tunnel"
cp app/motionai-tunnel.service "$HOME/.config/systemd/user/motionai-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable --now motionai-tunnel.service >/dev/null 2>&1
echo "installed into $BASE"
