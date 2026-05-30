# Sociafy GPU engines (Modal)

Two serverless GPU services that back Voice Twin (cloning TTS) and Avatar
(talking-head video). The Next.js app calls them over secret-authed HTTP and
polls for results; the engines upload artifacts straight to R2.

> The underlying open models are intentionally **not named** in any user-facing
> surface. Keep it that way — only these Python modules reference them.

## One-time setup

```bash
# Auth (already configured on this machine as workspace cbmix-com)
modal token new   # only if not already logged in

# Secrets (run once)
modal secret create sociafy-engine ENGINE_SECRET=<same value as MODAL_WEBHOOK_SECRET>
modal secret create sociafy-r2 \
  R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET_NAME=... R2_PUBLIC_URL_BASE=https://media.sociafy.app
```

## Deploy

```bash
modal deploy modal/voice_engine.py
modal deploy modal/avatar_engine.py
```

Each prints a `fastapi_app` base URL. Put them in the web app's env:

```
MODAL_VOICE_ENGINE_URL=https://<workspace>--sociafy-voice-engine-fastapi-app.modal.run
MODAL_AVATAR_ENGINE_URL=https://<workspace>--sociafy-avatar-engine-fastapi-app.modal.run
MODAL_WEBHOOK_SECRET=<same as ENGINE_SECRET>
```

Routes share one base URL per engine:
- voice: `POST /voice/prepare`, `POST /tts/submit`, `GET /tts/result?callId=`
- avatar: `POST /avatar/submit`, `GET /avatar/result?callId=`

## Benchmark → lock avatar pricing

The avatar credit prices in `lib/credits/pricing.ts`
(`avatar_video_480p` / `avatar_video_720p`) are conservative estimates. After
deploy, render one representative clip per quality, read the GPU-seconds from
the Modal dashboard, and set:

```
credits = ceil(measured_provider_cost * 1.10 / 0.009)   # 1 credit = $0.009 raw
```

If a single H100 OOMs on the 1.5 checkpoint, change `AvatarEngine`'s
`gpu="H100"` to `gpu="A100-80GB:2"` and add `--context_parallel_size=2` to the
inference command in `render()`.

## Notes
- Weights are cached in Modal Volumes (`sociafy-voice-weights`,
  `sociafy-avatar-weights`) so cold starts don't re-download.
- Without these env vars the web app runs in **stub mode** (placeholder assets),
  so local development needs no GPU.
