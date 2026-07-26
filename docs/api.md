# Sociafy Media API — v1

Four endpoints. Generate video and images with your own API key, metered against
your Sociafy credit balance. You do not need an account with any generation
provider — Sociafy calls them with its own credentials and bills you in credits.

Base URL: `https://sociafy.app`

---

## 1. Authentication

Every request needs a Bearer API key. Create one in your dashboard under
**Settings → API keys**; the plaintext key is shown exactly once.

```
Authorization: Bearer sfy_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are hashed at rest, so a lost key cannot be recovered — revoke it and make
a new one. A revoked key returns `401` immediately.

Two things every key has:

- **A credit balance**, shared across your whole account (dashboard usage and API
  usage draw from the same ledger).
- **A 24-hour credit cap**, per key. This is a rolling window, not a calendar
  day, and it is a spend limit, not a request limit. Raise it in the dashboard.

---

## 2. `GET /api/v1/me`

Check that a key works and see what it can still spend. Costs no credits.

```bash
curl https://sociafy.app/api/v1/me \
  -H "Authorization: Bearer $SOCIAFY_API_KEY"
```

```json
{
  "balance": 4820,
  "key_prefix": "sfy_live_a1b2c3",
  "credits_charged_today": 540,
  "daily_cap": 2000,
  "daily_cap_remaining": 1460
}
```

`credits_charged_today` is the gross credits this key has charged in the last 24
hours. Refunds (see §6) are **not** netted out of it, so a run of failed
generations still counts against the cap until the window rolls off. `balance`
is always exact and does reflect refunds.

---

## 3. `POST /api/v1/videos`

Submit a text-to-video generation. Returns immediately with `202` — generation
takes 30–120 seconds, so you poll (§4) rather than holding a connection open.

```bash
curl -X POST https://sociafy.app/api/v1/videos \
  -H "Authorization: Bearer $SOCIAFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-8891-clip-1" \
  -d '{
    "prompt": "slow dolly-in on a neon ramen bar at night, steam rising, shallow depth of field",
    "duration_sec": 8,
    "quality": "720p",
    "aspect": "9:16",
    "fast": false
  }'
```

```json
{
  "id": "8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901",
  "status": "pending",
  "credits_charged": 180,
  "duration_sec": 8,
  "quality": "720p",
  "aspect": "9:16",
  "poll_url": "/api/v1/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901"
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string, 2–2000 chars | required | Used verbatim. There is no prompt rewriting on the API — what you send is what the model sees. |
| `duration_sec` | integer 4–15 | `8` | Priced pro-rata; see §5. |
| `quality` | `480p` \| `720p` \| `1080p` | `720p` | 1080p costs ~5× 480p. |
| `aspect` | `9:16` \| `1:1` \| `16:9` | `9:16` | |
| `fast` | boolean | `false` | Cheaper and quicker, slightly lower fidelity. Ignored at 1080p, which has no fast tier — you are billed the quality price. |
| `gen_mode` | `"text"` | `"text"` | Text-to-video only, see below. |

**Unknown fields are rejected with `400`.** A typo in `quality` should not
silently bill you for a default you did not choose.

**Image-to-video and reference/character modes are not available in v1.** They
carry a per-input-second surcharge derived from probing the length of the clip
you supply, and that probe returns nothing for fragmented MP4 and for WebM —
which means we cannot price those requests correctly. We would rather refuse
than guess with your money. `gen_mode: "reference"` returns `400
invalid_request`.

Generate several clips by making several requests, each with its own
`Idempotency-Key`. There is no `count` parameter — one request is one job, one
charge, one id.

---

## 4. `GET /api/v1/videos/{id}`

Poll every 5–10 seconds until `status` is `completed` or `failed`.

```bash
curl https://sociafy.app/api/v1/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901 \
  -H "Authorization: Bearer $SOCIAFY_API_KEY"
```

```json
{
  "id": "8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901",
  "status": "completed",
  "video_url": "https://cdn.sociafy.app/users/user_2ab.../vid-1753538201-9f3c.mp4",
  "credits_charged": 180,
  "error": null
}
```

`status` is one of `pending`, `completed`, `failed`. While `pending`,
`video_url` and `error` are both `null`.

`credits_charged` is what the job debited, as history. On a `failed` job those
credits are refunded automatically — check `GET /api/v1/me` for your live
balance, not this field.

Polling is what drives delivery, but it is not the only thing that does: a job
completes and is stored even if you stop polling, so a crashed worker loses
nothing. `video_url` is served from Sociafy storage and is durable — the
generation provider's own URL expires within hours, and we copy the file before
handing you a link.

A job id belonging to another account returns `404`, identical to an id that
never existed.

---

## 5. `POST /api/v1/images`

Synchronous — a single image lands in roughly 10–40 seconds.

```bash
curl -X POST https://sociafy.app/api/v1/images \
  -H "Authorization: Bearer $SOCIAFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-8891-hero" \
  -d '{
    "prompt": "overhead flat-lay of a matcha latte on warm oak, soft window light",
    "size": "1024x1024",
    "quality": "medium"
  }'
```

```json
{
  "id": "c11e8a4f-2d33-4c9a-8b71-0a5e6f2c4d18",
  "image_url": "https://cdn.sociafy.app/users/user_2ab.../api-1753538330-7b1a.png",
  "credits_charged": 6
}
```

| Field | Type | Default |
|---|---|---|
| `prompt` | string, 2–2000 chars | required |
| `size` | `1024x1024` \| `1536x1024` \| `1024x1536` | `1024x1024` |
| `quality` | `low` \| `medium` \| `high` | `medium` |

Unknown fields are rejected with `400`, and there is no `count` — one request,
one image, one charge.

---

## 6. Credit costs

Charged at submission. Nothing else on the request is billable — no charge for
polling, for `GET /api/v1/me`, or for a request rejected with `400`/`401`/`429`.

**Video, 4–12 s** (scaled pro-rata from the 8 s price, e.g. 6 s at 720p quality
= `180 × 6/8` = 135):

| Quality | `fast: true` | `fast: false` |
|---|---|---|
| 480p | 75 | 90 |
| 720p | 145 | 180 |
| 1080p | — | 445 |

**Video, 13–15 s** (scaled pro-rata from the 15 s price; no fast tier):

| Quality | Credits |
|---|---|
| 480p | 168 |
| 720p | 335 |
| 1080p | 835 |

**Images:**

| Quality | Square (1024×1024) | Portrait / landscape |
|---|---|---|
| low | 2 | 2 |
| medium | 6 | 6 |
| high | 24 | 23 |

### Refunds

Credits come back automatically, to the credit, when we fail to deliver:

- The provider rejects or fails the generation.
- The generation finishes but we cannot store the result.
- A submission is never acknowledged (refunded after a 10-minute grace window).
- A job is still unfinished after 2 hours.

You never need to ask for these, and they are applied at most once per charge.
If a request returns `4xx` before generation starts, nothing was charged in the
first place.

---

## 7. Idempotency

Send an `Idempotency-Key` header on every `POST`. It is optional, but without one
a retried request is a second charge.

```
Idempotency-Key: order-8891-clip-1
```

8–200 printable ASCII characters. A malformed key is rejected with `400` rather
than ignored — if you sent a key you are relying on it, so silently dropping it
would be worse than failing.

Semantics:

- **Same key, replayed after the first request completed** → the original job.
  Same `id`, same `credits_charged`, no second charge, no second generation. The
  response carries `Idempotency-Replay: true`.
- **Same key, replayed while the first request is still in flight** → for videos,
  the original job (the charge lands before the provider is called, so the id
  already exists). For images, `409 request_in_progress` — the image is not
  stored yet, and we will not invent a result or charge you twice. Retry the
  same key in a few seconds.
- **Same key, different body** → the original job. The key is the identity of the
  request; we do not re-generate with new parameters under an old key. Use a new
  key when the parameters change.
- **Keys are scoped to your account** and never expire. Reusing a key from last
  month returns last month's job. Derive keys from something already unique on
  your side (`order-8891-clip-1`), not from a timestamp.

Idempotency covers the *charge*, which is the part that costs money. It does not
deduplicate at the network layer: two requests fired in the same millisecond
still both reach us, but only one of them pays.

---

## 8. Errors

Every error is JSON with a stable `error` code and a human `message`. Match on
`error`, never on `message`.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Body failed validation. `issues[]` names up to 5 offending fields. |
| 400 | `invalid_idempotency_key` | Not 8–200 printable ASCII characters. |
| 400 | `prompt_rejected` | The content filter refused the prompt. Credits were refunded. |
| 401 | `unauthorized` | Missing, malformed, unknown, or revoked API key. |
| 402 | `insufficient_credits` | Includes `balance` and `needed`. Top up and retry. |
| 404 | `not_found` | No such generation for this account. |
| 409 | `request_in_progress` | An image request with this `Idempotency-Key` has not finished yet. Retry the same key. |
| 429 | `rate_limited` | Short-term burst limit. Honour `retry_after_sec`. |
| 429 | `daily_cap_exceeded` | This key hit its rolling 24-hour credit cap. Includes `spent` and `cap`. |
| 429 | `api_capacity_exceeded` | Platform-wide daily limit. Not your fault; retry later. |
| 502 | `upstream_error` | Generation failed at the provider. Credits were refunded. Safe to retry with a **new** idempotency key. |
| 503 | `service_unavailable` | Generation is temporarily offline. Nothing was charged. |
| 500 | `internal` | Our bug. Nothing was charged, or it was refunded. |

Failed video jobs report a code in the `error` field of `GET /api/v1/videos/{id}`
rather than at the HTTP layer, since the request that fetched them succeeded:

| `error` | Meaning |
|---|---|
| `generation_rejected` | The provider refused the request outright. |
| `generation_failed` | Generation started and did not produce a usable clip. |
| `generation_timeout` | The job never finished. |
| `storage_failed` | Generated, but we could not store it. |
| `charge_failed` | The charge did not go through; nothing was generated. |

All five are refunded.

---

## 9. Putting it together

```bash
#!/usr/bin/env bash
set -euo pipefail

KEY="$SOCIAFY_API_KEY"
IDEM="campaign-2026-07-hero-01"   # stable, derived from your own data

id=$(curl -sS -X POST https://sociafy.app/api/v1/videos \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEM" \
  -d '{"prompt":"aerial push over a foggy pine ridge at sunrise","quality":"720p","aspect":"16:9"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

# Seedance-class models resolve in 30-120s; 5s polling is plenty.
for _ in $(seq 1 60); do
  body=$(curl -sS "https://sociafy.app/api/v1/videos/$id" -H "Authorization: Bearer $KEY")
  status=$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$status" = "pending" ] || { printf '%s\n' "$body"; exit 0; }
  sleep 5
done

echo "still pending after 5 minutes" >&2; exit 1
```

Retrying the whole script with the same `IDEM` is free and returns the same
clip.

---

## 10. Not in v1

Named so you build around them rather than waiting:

- **Outbound webhooks.** Poll instead; at this volume it is cheaper for both of
  us than you operating a public endpoint.
- **Image-to-video and reference modes.** See §3 — a pricing correctness
  problem, not an effort one.
- **Batch parameters.** One request, one job, one charge. Loop.
- **Streaming or progress percentages.** `status` is `pending` until it isn't.
- **Postpaid billing.** Prepaid credits are also the spend cap; a balance cannot
  go negative.
