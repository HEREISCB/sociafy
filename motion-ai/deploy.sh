#!/usr/bin/env bash
# Deploy the motion-ai worker from this laptop to the L40S box:  bash motion-ai/deploy.sh
set -euo pipefail
BOX=${BOX:-l40ssociafy}
PROD=${PROD:-sociafy}
cd "$(dirname "$0")"
node --test lib.test.mjs >/dev/null

ssh "$BOX" 'mkdir -p ~/motionai/app ~/motionai/home/.claude/skills'
rsync -a --delete --exclude deploy.sh ./ "$BOX":motionai/app/
for s in hyperframes hyperframes-core hyperframes-animation hyperframes-cli hyperframes-creative hyperframes-keyframes hyperframes-registry general-video media-use hyperframes-audio; do
  rsync -a --delete ~/.claude/skills/$s "$BOX":motionai/home/.claude/skills/
done

# R2 creds: copied once from the prod app's .env, never echoed. NEXT_PUBLIC_R2_PUBLIC_URL_BASE -> R2_PUBLIC_URL_BASE.
if ! ssh "$BOX" 'grep -q "^R2_ACCOUNT_ID=" ~/motionai/.env 2>/dev/null'; then
  ssh "$PROD" 'grep -E "^(R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET_NAME|NEXT_PUBLIC_R2_PUBLIC_URL_BASE)=" /home/ubuntu/sociafy/.env' \
    | sed 's/^NEXT_PUBLIC_//' \
    | ssh "$BOX" 'umask 077; mkdir -p ~/motionai; cat >> ~/motionai/.env'
fi

ssh "$BOX" 'bash ~/motionai/app/install.sh'
ssh "$BOX" 'sleep 2; systemctl --user is-active motionai'
