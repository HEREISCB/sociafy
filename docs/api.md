    # Sociafy Media API — v1

    Five endpoints. Generate video and images with your own API key, metered against
    your Sociafy credit balance. You do not need an account with any generation
    provider — Sociafy calls them with its own credentials and bills you in credits.

    Base URL: `https://sociafy.app`

    **Server-to-server only.** No endpoint sends CORS headers, so a browser cannot
    call this API directly — and should not, since the credential is a secret that
    spends money.

    **`POST /api/v1/images` has two modes, and you want the asynchronous one.** Send
    `"async": true` and it answers `202` in well under a second with an id you poll —
    the same shape `POST /api/v1/videos` has always had. The synchronous mode is still
    the default, so existing integrations are untouched, but it holds the connection
    open for the whole generation: measured at 66–78 s text-only and about 83 s
    with one reference image. The 60-second default that most
    HTTP clients apply unasked therefore fails by about ten seconds on *nearly every*
    synchronous call, as a bare read timeout that cannot tell you whether you were
    charged. Reference images make it worse: up to 20 MB each and 64 MB per request,
    uploaded before generation starts.

    If you stay synchronous, **set your client timeout to at least 180 seconds**, and
    read §8 — a timed-out request's charge is recoverable by retrying the same
    `Idempotency-Key`. `POST /api/v1/videos` returns in a second or two; none of this
    is about it.

    We may make `async: true` the default in a future version of this API, announced
    before it happens. Sending it explicitly today is how you become immune to that.

    ---

    ## 1. Authentication

    Every request needs a Bearer API key. Create one in your dashboard under
    **Account → API keys** (`/account/api`); the plaintext key is shown exactly once.

    ```
    Authorization: Bearer sfy_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    ```

    Keys are hashed at rest, so a lost key cannot be recovered — revoke it and make
    a new one. A revoked key returns `401` immediately. You may hold up to **10
    active keys**; an eleventh returns `400 too_many_keys` until you revoke one.

    Key management is **session-only**. `/api/keys` authenticates with your dashboard
    session, not with an API key, so a key cannot list, create, or rotate keys —
    including itself. Rotation is a human action in the dashboard: create the new
    key, deploy it, then revoke the old one.

    Two things every key has:

    - **A credit balance**, shared across your whole account (dashboard usage and API
      usage draw from the same ledger).
    - **A 24-hour credit cap**, per key. This is a rolling window, not a calendar
      day, and it is a spend limit, not a request limit. New keys default to **2,000
      credits/day**. Set a different cap when you create the key, or edit an existing
      key's cap in place under Account → API keys.

    The cap is checked *before* a request is priced, not against its price, so the
    request that crosses the line is allowed through in full and **one job can
    overshoot the cap by its own cost**. A 1080p video submitted at 1,999 of a 2,000
    cap lands you at 2,444 spent. Size the cap with one maximum-priced job of
    headroom if that matters to you.

    There is also a platform-wide 24-hour ceiling across all API customers, default
    **50,000 credits**, which exists to protect our upstream provider balance. It
    surfaces as `429 api_capacity_exceeded` and is not about your key.

    Spend caps apply to the `POST` endpoints only. A `GET` never charges, so it is
    never capped — you can always poll a job you already paid for, and `GET
    /api/v1/me` keeps working while you are over the cap, which is exactly when you
    need it.

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

    `credits_charged_today` is the **net** credits this key has spent in the last 24
    hours: refunds (see §7) are subtracted, so a run of failed generations does not
    burn your daily cap. It is the same figure the cap is enforced against, so
    `daily_cap_remaining` is exactly how much you can still spend.

    Status codes: `200`, `401`, `500`, `503`.

    ---

    ## 3. `GET /api/v1/models`

Which models `POST /api/v1/videos` accepts, and what each one can do. Built from
the same table the request validator rejects against, so it cannot disagree with
what the endpoint allows: stay inside the envelope described here and you will
not see a `400` for an unsupported combination.

```bash
curl -s https://sociafy.app/api/v1/models \
  -H "Authorization: Bearer $SOCIAFY_API_KEY"
```

```json
{
  "models": [
    {
      "id": "sociafy-motion-1",
      "type": "video",
      "name": "Sociafy Motion 1",
      "summary": "General-purpose social video up to 30s...",
      "default": true,
      "available": true,
      "capabilities": {
        "duration_sec": { "min": 4, "max": 30 },
        "quality": ["480p", "720p", "1080p"],
        "aspect": ["9:16", "1:1", "16:9"],
        "gen_mode": ["text", "reference", "image-to-video"],
        "native_audio": false,
        "fast_tier": true,
        "fast_max_sec": 15
      },
      "example": { "duration_sec": 8, "quality": "720p", "credits": 315 }
    },
    {
      "id": "sociafy-cinema-1",
      "type": "video",
      "name": "Sociafy Cinema 1",
      "summary": "Longer, sound-on video up to 30s...",
      "default": false,
      "available": true,
      "capabilities": {
        "duration_sec": { "min": 4, "max": 30 },
        "quality": ["480p", "720p"],
        "aspect": ["9:16", "1:1", "16:9"],
        "gen_mode": ["text"],
        "native_audio": true,
        "fast_tier": false,
        "fast_max_sec": null
      },
      "example": { "duration_sec": 8, "quality": "720p", "credits": 33 }
    }
  ]
}
```

`example` is indicative — one representative render so you can compare models
without submitting. It is `null` when a price could not be quoted; that is a
signal to retry the read, not to assume a cost.

`available: false` means the model is configured out right now. A submit against
it answers `503` and charges nothing, so fall back to another model rather than
retrying the same one.

**The two models**

| | `sociafy-motion-1` | `sociafy-cinema-1` |
|---|---|---|
| Length | 4–30s (`fast`: up to 15s) | 4–30s |
| Sound | silent | **scores its own audio** |
| Quality | 480p, 720p, 1080p | 480p, 720p |
| Still images as input | yes | not yet |
| `fast` tier | yes | no |
| 8s at 720p | 315 credits | 33 credits |

Cinema writes its own soundtrack from the prompt. End the prompt with an
`Audio:` line to direct it — *"Audio: room tone, one ceramic knock, distant
traffic."* Say nothing and it invents something plausible, which is rarely what
you wanted.

Cinema renders take **minutes, not seconds** — roughly 100s for a 4s clip and
proportionally more beyond that, because a longer clip costs more than linearly.
Poll on the same 5s interval; just expect a longer wait. It also runs a **small
finite pool**: when every slot is busy a submit answers `429 model_busy` with
`retry_after_sec`, and nothing is charged.

Status codes: `200`, `401`, `500`, `503`.

---

    ## 4. `POST /api/v1/videos`

    Submit a video generation — from a prompt alone, or from still images of the
    real thing. Returns `202` immediately — generation takes 30–120 seconds, so you
    poll (§5) rather than holding a connection open.

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
      "credits_charged": 315,
      "model": "sociafy-motion-1",
      "duration_sec": 8,
      "quality": "720p",
      "aspect": "9:16",
      "poll_url": "/api/v1/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901"
    }
    ```

    | Field | Type | Default | Notes |
    |---|---|---|---|
    | `prompt` | string, 2–2000 chars | required | Used verbatim. There is no prompt rewriting on the API — what you send is what the model sees. |
    | `model` | `sociafy-motion-1` \| `sociafy-cinema-1` | `sociafy-motion-1` | Which model renders it. Each has its own limits — see §3. |
    | `duration_sec` | integer 4–30 | `8` | Both models render up to 30. Priced pro-rata on Motion; quoted per request on Cinema. See §6. |
    | `quality` | `480p` \| `720p` \| `1080p` | `720p` | 1080p costs ~5× 480p, and is Motion only. |
    | `aspect` | `9:16` \| `1:1` \| `16:9` | `9:16` | |
    | `fast` | boolean | `false` | Cheaper and quicker, slightly lower fidelity. Ignored at 1080p and above 15s (`fast_max_sec`), which have no fast tier — you are billed the quality price. |
    | `gen_mode` | `text` \| `reference` \| `image-to-video` | `text` | Which still images, if any, the clip is built from. See below. Cinema takes `text` and `image-to-video`; `reference` is Motion only. |
    | `reference_images` | array of 1–9 `https` URLs | omitted | **`gen_mode: "reference"` only, and required by it.** Photos of the real subject, so the clip shows *your* product rather than an approximation of it. |
    | `start_frame` | `https` URL | omitted | **`gen_mode: "image-to-video"` only, and required by it.** The clip's first frame. |
    | `end_frame` | `https` URL | omitted | `gen_mode: "image-to-video"` only. The clip's last frame, if you want to pin where it lands. **On Cinema it may be sent alone**, with no `start_frame` — "end here, work out how to arrive". Motion always needs a `start_frame`. |
    | `match_frame_aspect` | boolean | `false` | **Cinema + `image-to-video` only.** Take the canvas *shape* from your frame instead of from `aspect`, so a portrait still is not rendered into a landscape box. Overrides `aspect` when set, which is why it is opt-in rather than automatic. Shape only: `quality` still sets the area, so it does not change the price. |

    **Unknown fields are rejected with `400`.** A typo in `quality` should not
    silently bill you for a default you did not choose.

    **A request outside the chosen model's envelope is also a `400`, never a
    downgrade.** Asking `sociafy-cinema-1` for `1080p` is refused and costs
    nothing; it is not quietly served at 720p and billed in full. The `issues`
    array names the field and the values that model does accept.

    `status`, `model`, `duration_sec`, `quality` and `aspect` always describe the **stored
    job**, which matters on an idempotent replay: replaying a key whose job already
    finished returns that job's real status and its original parameters, not the
    parameters you just sent. A replay that resolves to a `failed` job also carries
    an `error` field with the same code `GET /api/v1/videos/{id}` would give, so you
    do not go off and poll something that can never succeed.

    `202` is returned on both a fresh submit and a replay.

    Generate several clips by making several requests, each with its own
    `Idempotency-Key`. There is no `count` parameter — one request is one job, one
    charge, one id. **Mind the burst limit while you do** (§9): three submits, then
    one every 100 seconds. A batch of ten clips takes about fifteen minutes to get
    in the door.

    ### Still images as input

    Two modes take images, and both cost **exactly the same as text-to-video** — the
    provider prices video per output second, and still input adds nothing to that, so
    there is no surcharge to pass on. Compare `reference_images` on `POST
    /api/v1/images`, which does carry one (§7), because that provider bills input
    image tokens.

    - **`gen_mode: "reference"`** with `reference_images`: 1–9 photos of the real
      subject. The clip depicts *those*, which is the difference between "a gold
      solitaire ring" and your gold solitaire ring. Several angles beat one.
    - **`gen_mode: "image-to-video"`** with `start_frame` (and optionally
      `end_frame`): the clip begins on that image, and ends on the other if you send
      one — the way to animate a photo you already have.

    ```bash
    curl -X POST https://sociafy.app/api/v1/videos \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: style-4471-reel" \
      -d '{
        "prompt": "slow turntable of this ring on white marble, soft window light",
        "gen_mode": "reference",
        "reference_images": [
          "https://cdn.example.com/styles/4471/front.jpg",
          "https://cdn.example.com/styles/4471/side.jpg"
        ],
        "duration_sec": 8,
        "quality": "720p"
      }'
    ```

    **Send the field its mode requires, and nothing else.** A `reference_images` on
    `gen_mode: "text"`, a `start_frame` on `gen_mode: "reference"`, a `reference`
    without images — each is `400 invalid_request` naming the field. We do not pick a
    winner among contradictory fields; guessing spends your credits on a request you
    did not make.

    **The URLs must be reachable by us, at submit time.** We fetch each image and
    re-host it, then hand the generation provider *our* copy — your host is never
    disclosed to them, and a URL that is signed, private or short-lived cannot fail
    opaquely on their side after you have been charged. The requirements are exactly
    those in §6 (`https` only, no redirects, publicly resolvable host, `png`/`jpeg`/
    `webp` verified by magic bytes, 20 MB each and 64 MB in total, 20 s each and 60 s
    across all of them), and each violation is its own `400` carrying `reference_url`.
    Nothing is charged for any of them. The fetch runs before the charge, so a
    non-text submit answers in seconds rather than the usual one or two.

    **Reference *video* is still not available.** Only it carries the provider's
    per-input-second surcharge, and pricing that means probing the length of the clip
    you supply — a probe that returns nothing for fragmented MP4 and for WebM, so we
    cannot bill those requests correctly. We would rather refuse than guess with your
    money. There is no field for it; sending one is a `400`.

    Status codes: `202`, `400`, `401`, `402`, `409`, `429`, `500`, `502`, `503`.

    ---

    ## 5. `GET /api/v1/videos/{id}`

    Poll every 5–10 seconds until `status` is `completed` or `failed`. Polling is not
    rate-limited; 5 seconds is advice about not wasting your own sockets, not a limit
    we enforce. Please do not poll faster than once a second.

    ```bash
    curl https://sociafy.app/api/v1/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901 \
      -H "Authorization: Bearer $SOCIAFY_API_KEY"
    ```

    ```json
    {
      "id": "8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901",
      "model": "sociafy-motion-1",
      "status": "completed",
      "video_url": "https://<your-media-host>/users/user_2ab.../vid-1753538201-9f3c.mp4",
      "credits_charged": 315,
      "error": null
    }
    ```

    `status` is one of `pending`, `completed`, `failed`. While `pending`,
    `video_url` and `error` are both `null`.

    **`completed` always carries a usable `video_url`.** The status and the URL become
    visible in the same commit, so you never need to defend against a `completed` with
    a null URL — if the file is not deliverable yet the job still reads `pending`, and
    you keep polling. Treat `completed` as "take `video_url`", nothing more.

    `credits_charged` is what the job debited, as history. On a `failed` job those
    credits are refunded automatically — check `GET /api/v1/me` for your live
    balance, not this field.

    Polling is what drives delivery, but it is not the only thing that does: a job
    completes and is stored even if you stop polling, so a crashed worker loses
    nothing. `video_url` is served from Sociafy storage — the generation provider's
    own URL expires within hours, and we copy the file before handing you a link.

    A job id belonging to another account returns `404`, identical to an id that
    never existed. So does a malformed id.

    This endpoint can also return `503 service_unavailable` if storage or the
    generation backend is offline: the poll cannot finalize the job, but nothing is
    lost and nothing is charged — retry.

    Status codes: `200`, `401`, `404`, `500`, `503`.

    ### Output URLs

    Media URLs are unsigned, public, and permanent for as long as the object exists.
    The host comes from our storage configuration, so treat it as opaque — do not
    hardcode it or parse it. There is no expiry and no deletion schedule today, but
    we do not offer a retention SLA in v1: **if you need the asset to outlive our
    storage decisions, copy it into your own bucket.**

    ---

    ## 6. `POST /api/v1/images`

    Two modes on one endpoint. **Prefer `async: true`** — it books and charges the job,
    answers `202` immediately, and you poll for the result exactly as you do for
    video. The synchronous mode is the default only so that code written before
    `async` existed keeps behaving identically.

    ### Asynchronous (recommended)

    ```bash
    curl -X POST https://sociafy.app/api/v1/images \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: order-8891-hero" \
      -d '{
        "prompt": "overhead flat-lay of a matcha latte on warm oak, soft window light",
        "size": "1024x1024",
        "quality": "medium",
        "async": true
      }'
    ```

    ```json
    {
      "id": "b4d1f0c9-7e52-4a18-9c3b-2f7a41d0e6b5",
      "status": "pending",
      "credits_charged": 6,
      "poll_url": "/api/v1/images/b4d1f0c9-7e52-4a18-9c3b-2f7a41d0e6b5"
    }
    ```

    `202` on both a fresh submit and a replay, like `POST /api/v1/videos`. Credits are
    charged here, at submission, before the response is sent — so the answer to "was I
    charged?" is in the response body, and if you never get a response you can find
    out by replaying the key (§8).

    `status` is the stored job's real status, so a replay of a key whose job already
    finished says `completed` rather than `pending`, and a replay resolving to a
    `failed` job also carries `error`.

    The generation itself runs after the response, on our side. Then poll:

    ### `GET /api/v1/images/{id}`

    ```bash
    curl https://sociafy.app/api/v1/images/b4d1f0c9-7e52-4a18-9c3b-2f7a41d0e6b5 \
      -H "Authorization: Bearer $SOCIAFY_API_KEY"
    ```

    ```json
    {
      "id": "b4d1f0c9-7e52-4a18-9c3b-2f7a41d0e6b5",
      "status": "completed",
      "image_url": "https://<your-media-host>/users/user_2ab.../api-1753538330-7b1a.png",
      "credits_charged": 6,
      "error": null
    }
    ```

    `status` is one of `pending`, `completed`, `failed`; while `pending`, `image_url`
    and `error` are both `null`. **`completed` always carries a usable `image_url`** —
    status and URL become visible in the same commit, so a `completed` with a null URL
    is not a shape you have to handle; a job that is not deliverable yet still reads
    `pending`. A `failed` job names its reason in `error` (§10) and
    its credits are refunded automatically. Poll every 5 seconds — most jobs land in
    70–90 seconds, and `high` quality or several references take longer. Reads are
    free, uncapped and not rate-limited, but please stay under one request a second.

    Unlike video, polling only *reports*: the job finishes whether or not anyone
    polls, and a job whose generation is lost mid-flight is failed and refunded by a
    background sweeper within about ten minutes. An id belonging to another account
    returns `404`, identical to one that never existed, and so does a malformed id.

    Status codes: `200`, `401`, `404`, `500`, `503`.

    ### Synchronous (the default)

    Omit `async` (or send `false`) and the connection is held open until the image is
    generated, then answered `200` — unchanged from the first version of this
    endpoint.

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
      "image_url": "https://<your-media-host>/users/user_2ab.../api-1753538330-7b1a.png",
      "credits_charged": 6
    }
    ```

    Note that `id` means different things in the two modes: the id of the **image**
    here, the id of the **job** on the async path. Only the async id is pollable.

    ### Fields

    | Field | Type | Default |
    |---|---|---|
    | `prompt` | string, 2–32,000 chars | required |
    | `size` | a preset name, or `WxH` in pixels — see below | `1024x1024` |
    | `quality` | `low` \| `medium` \| `high` | `medium` |
    | `reference_images` | array of 1–16 `https` URLs — see below | omitted |
    | `mask` | one `https` URL of a PNG with alpha — requires `reference_images`; see [Masked edits](#masked-edits) | omitted |
    | `preserve_masked_pixels` | boolean — with a `mask`, paste the first reference's pixels back wherever the mask is opaque; output is at the reference's dimensions | `true` (with a `mask`) |
    | `async` | boolean — `true` returns `202` + `poll_url` instead of holding the connection open | `false` |

    Unknown fields are rejected with `400`, and there is no `count` — one request,
    one image, one charge. Everything else is identical between the two modes: same
    validation, same prices, same refunds, same idempotency, same reference-image
    handling.

    #### Sizes

    `size` takes either a **social preset** or an explicit **`WxH`** in pixels. One
    field for both, so there is never a question of which wins.

    | Preset | Pixels | Ratio |
    |---|---|---|
    | `ig_square` | `1024x1024` | 1:1 |
    | `ig_portrait` | `1088x1360` | 4:5 |
    | `ig_story` | `864x1536` | 9:16 |
    | `ig_landscape` | `1456x768` | 1.9:1 |
    | `fb_square` | `1024x1024` | 1:1 |
    | `fb_story` | `864x1536` | 9:16 |
    | `fb_link` | `1456x768` | 1.9:1 |
    | `x_post` | `1536x864` | 16:9 |
    | `x_header` | `1536x512` | 3:1 |
    | `li_post` | `1456x768` | 1.9:1 |
    | `li_banner` | `1536x512` | 3:1 |
    | `yt_thumbnail` | `1280x720` | 16:9 |
    | `tiktok` | `864x1536` | 9:16 |
    | `pinterest_pin` | `1024x1536` | 2:3 |

    A **custom `WxH`** must satisfy all of:

    - both edges divisible by **16**
    - at least **692,224** pixels in total
    - at most **1,048,576** pixels in total (the area of a `1024x1024`)
    - aspect ratio within **3:1** either way

    The divisibility rule is why the numbers the platforms publish do not work
    verbatim: Instagram's own `1080x1350` is rejected, because 1080 and 1350 are not
    multiples of 16. `1088x1360` is the identical 4:5 shape and renders fine, which
    is what `ig_portrait` sends. A rejected size names a valid alternative with the
    **same** aspect ratio, so the fix is one edit rather than a search.

    Two limits are the engine's own and cannot be worked around: nothing wider than
    3:1 renders at all (so LinkedIn's 4:1 banner is unavailable — `li_banner` is the
    closest renderable shape), and nothing below the pixel minimum.

    The three original sizes — `1024x1024`, `1536x1024`, `1024x1536` — still work and
    still cost exactly what they always did. `1024x1536` is deliberately exempt from
    the custom pixel ceiling so that existing integrations do not move.

    **Pricing.** Presets and custom sizes are billed at the square rate for their
    `quality`. Only the two original non-square sizes keep the slightly cheaper
    non-square rate. Nothing gets more expensive than it is today.

    **Timing.** Text-only, `quality: "medium"` has been measured at **66–78 seconds**
    across five runs; with one reference image, **about 83 s**. `high` is
    slower, `low` is faster. References add up to 60 seconds of fetching plus the time
    to upload up to 64 MB of them, so plan for **up to ~3 minutes** on that path.
    Asynchronously none of that reaches your client, which sees a `202` in under a
    second. **Synchronously it is all wall-clock time on your socket:** the request is
    held open for up to 300 seconds, so set your client timeout to at least 180 s — a
    60-second default fails on almost every request. If the connection ends without a
    result, retry the same `Idempotency-Key` (§8) to find out whether you were
    charged; the refund caveat in §7 also applies to that path only.

    Status codes: `200` (sync), `202` (async), `400`, `401`, `402`, `409`, `429`,
    `500`, `502`, `503`.

    ### Reference images

    Pass photos of the real thing and the output is guided by them, not just by your
    words — the case this exists for is a catalogue: *"here is the product, here are
    its specs, shoot it on white marble."*

    ```bash
    curl -X POST https://sociafy.app/api/v1/images \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: style-4471-hero" \
      -d '{
        "prompt": "this exact ring on white marble, soft window light, 45° three-quarter view",
        "reference_images": [
          "https://cdn.example.com/styles/4471/front.jpg",
          "https://cdn.example.com/styles/4471/side.jpg"
        ],
        "size": "1024x1024",
        "quality": "medium"
      }'
    ```

    One field covers both cases: a single reference is a one-element array. Several
    angles of the same product usually beat one.

    **Likeness is guided, not guaranteed.** The model reproduces the *character* of
    what you send — form, materials, finish, colour. It is not a compositor and it
    does not clone: expect a faithful rendition, not a pixel-accurate copy of your
    photograph, and do not use it where an exact reproduction is a legal or
    contractual requirement (a hallmark, a serial number, engraved text).

    **There is no fidelity knob.** `input_fidelity` — the first parameter anyone
    integrating for product likeness reaches for — is not supported by the model
    behind this endpoint, which answers `invalid_input_fidelity_model`, so we do not
    send it and there is no field to set. Likeness is guided, not tunable. Send more
    angles rather than a bigger file: see the token table in §7 for why resolution
    does not help.

    Requirements, each of which is a distinct `400` if unmet:

    | Requirement | Why |
    |---|---|
    | `https` only, no redirects | We fetch these ourselves. `http` and a redirect chain are both refused; send the final URL. |
    | Publicly resolvable host | Private, loopback, link-local and metadata addresses are blocked in every notation. |
    | `image/png`, `image/jpeg` or `image/webp` | And the bytes must match the header — we check the magic bytes, not your `content-type`. |
    | At most 16 per request | The provider's documented maximum for one edit. |
    | Under 20 MB each, 64 MB in total | Enforced while downloading, so a missing or dishonest `content-length` does not help. We buffer every reference in memory at once, which is what the shared budget bounds — not the price. Sixteen typical 4000² catalogue JPEGs (~3–4 MB each) fit. |
    | Reachable within 20 s each, 60 s in total | A slow host costs you the whole request. |

    URLs on our own media host are held to exactly the same checks — hosting an
    object says nothing about its size or its contents.

    There is **no megapixel limit and no dimension requirement**. Both used to exist,
    purely to bound a per-megapixel charge that no longer exists (§7), so an image we
    cannot measure is no longer refused.

    Cost: the output price from §7 **plus a flat surcharge per reference image**,
    independent of its resolution. Nothing changes for a request without
    `reference_images`.

    ### Masked edits

    To keep a product exactly as photographed, build a canvas with the real product
    placed where you want it, and a mask the same size: **transparent where the
    model should paint, opaque over the product.** Send the canvas as the *first*
    reference and the mask as `mask`.

    ```bash
    curl -X POST https://sociafy.app/api/v1/images \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: style-4471-marble-masked" \
      -d '{
        "prompt": "white Carrara marble surface, soft window light from the left, shallow depth of field",
        "reference_images": ["https://cdn.example.com/styles/4471/canvas-1024.png"],
        "mask": "https://cdn.example.com/styles/4471/mask-1024.png",
        "size": "1024x1024",
        "quality": "high",
        "async": true
      }'
    ```

    Checked before anything is charged — each failure is a free `400 mask_invalid`
    carrying `mask_url`:

    | Requirement | |
    |---|---|
    | `reference_images` present | The mask applies to the first one. Without it: `400 invalid_request`. |
    | PNG with an alpha channel | RGBA or grey+alpha. A palette PNG with a transparency chunk is refused — re-export as RGBA. |
    | Under 4 MB | The provider's own limit. |
    | Exactly the first reference's width × height | As displayed: a JPEG's EXIF rotation is applied first (and the reference is sent to the model upright), so draw the mask over the photo as you see it. If we cannot read the first reference, the request is refused rather than risked. |
    | `size` the same shape as the first reference | Only while paste-back is on (below). Within 1%, the slack that multiples-of-16 sizes need. A different shape is `400 invalid_request` on `size`. |

    The mask URL is fetched with the references and passes the same checks (and
    shares their 64 MB / 60 s budget); a problem fetching it comes back as the usual
    `reference_*` code with `reference_url` set to your mask URL.

    **The product comes back exact — we paste it back.** The model treats a mask
    only as guidance and regenerates every pixel, so after it answers we lay your
    first reference's pixels back over its output wherever the mask is opaque, using
    the mask's alpha as the blend: fully opaque is exactly your pixels, fully
    transparent is exactly the model's, and a feathered edge is a smooth mix. This is
    on by default whenever you send a `mask`.

    - **The image you get is at the first reference's dimensions, not `size`.** The
      model renders at `size` (which must still be a valid size); its output is then
      resized to your canvas before the paste. So your canvas does *not* need to be a
      valid size itself: a `1000x1000` canvas with `size: "1024x1024"`, or a
      `1080x1350` canvas with `size: "ig_portrait"`, both come back at the canvas size
      with your product untouched. A large canvas means a large output: a 4000×4000
      canvas returns a 4000×4000 PNG, with the generated parts upscaled.
    - The response carries `"preserved_masked_pixels": true` (on the `200`, on a
      replay, and on a completed `GET /api/v1/images/{id}`). If it is ever `false`
      with paste-back on, the paste failed on our side and you received the model's
      raw output, at `size`. You are still charged — the image was generated — and
      the failure is logged for us to fix.
    - **Opt out** with `"preserve_masked_pixels": false` to get the model's raw output
      at `size`, with no shape requirement. Sending the field without a `mask` is a
      `400`.

    Cost: the mask is billed as one more reference image (6 credits). A single-canvas
    masked edit at `medium` is therefore `6 + 6 + 6` = **18 credits**.

    ---

    ## 7. Credit costs

    Charged at submission. Nothing else on the request is billable — no charge for
    polling, for `GET /api/v1/me`, or for a request rejected with
    `400`/`401`/`404`/`429`.

    **`sociafy-cinema-1` is quoted per request, not looked up in a table.** Its cost
    rises faster than linearly with length — 4s, 8s, 15s and 30s at 720p are
    **13, 33, 92 and 289 credits** — so there is no 8-second row to scale off.
    `GET /api/v1/models` returns the current 8s/720p figure; the exact charge for
    your request comes back as `credits_charged` on the `202`. 480p is roughly a
    third of the 720p price.

    **Video, 4–12 s** (scaled pro-rata from the 8 s price, e.g. 6 s at 720p quality
    = `315 × 6/8` = 236):

    | Quality | `fast: true` | `fast: false` |
    |---|---|---|
    | 480p | 75 | 135 |
    | 720p | 145 | 315 |
    | 1080p | — | 720 |

    **Video, 13–30 s** (scaled pro-rata from the 15 s price, e.g. 30 s at 720p = `591 × 2` = 1182; no fast tier):

    | Quality | Credits |
    |---|---|
    | 480p | 254 |
    | 720p | 591 |
    | 1080p | 1350 |

    **Video reference stills** (`reference_images`, `start_frame`, `end_frame`):
    **no surcharge.** The provider prices video per second of *output*; still input
    does not enter into it, so `gen_mode: "reference"` and `gen_mode:
    "image-to-video"` cost exactly what the same clip costs from a prompt alone. The
    only input that would be surcharged is a reference *video*, which is why that one
    is not offered (§4).

    **Images:**

    | Quality | Square (1024×1024) | Portrait / landscape |
    |---|---|---|
    | low | 2 | 2 |
    | medium | 6 | 6 |
    | high | 24 | 23 |

    **Image reference input** (`reference_images`), added to the price above:

    | Add-on | Credits |
    |---|---|
    | reference input | 6 credits per reference image |

    **Flat per image, whatever its resolution.** Worked examples at `quality:
    "medium"`, square:

    - one 4000×4000 catalogue photo → `6 + 6` = **12 credits**
    - one 512×512 thumbnail → also **12 credits**
    - four references, any sizes → `6 + 4 × 6` = **30 credits**

    Because the price is per image, `credits_charged` is fully computable from your
    request body before you send it: output tier + 6 × `len(reference_images)`, plus 6 if you send a `mask`.

    Why resolution is not in that formula: the provider bills reference input as
    image *tokens*, which are patch-based and clamped, and it downscales your file
    internally before the model sees it. Measured on the live API — same model, one
    reference each, `size: "1024x1024"`, `quality: "low"`:

    | Reference | Megapixels | Input image tokens | Output tokens |
    |---|---|---|---|
    | 512×512 | 0.25 | 1,024 | 196 |
    | 1024×1024 | 1.05 | 1,024 | 196 |
    | 2048×2048 | 4.0 | **1,521** | 196 |
    | 4000×4000 | 16.0 | **1,521** | 196 |

    A floor of 1,024 and a ceiling of 1,521, i.e. a 16 MP source costs us exactly
    what a 4 MP one does. So **uploading a larger source neither costs you more nor
    improves likeness** — those pixels are discarded before the model sees them. Send
    another angle instead; it does more for the result than more pixels ever will. The
    20 MB cap exists so masters do not have to be re-exported, not because big files
    are better.

    This used to be priced per megapixel, which billed a 4000×4000 photo 64 credits of
    surcharge — 70 in total — against a provider cost bounded at 1,521 tokens. That
    was wrong and it is fixed; the same request is now 12. A request with no
    `reference_images` is priced exactly as it was before this field existed.

    ### Refunds

    Credits come back automatically, to the credit, when we fail to deliver:

    - The provider rejects or fails the generation.
    - The generation finishes but we cannot store the result.
    - A video submission is never acknowledged (refunded after a 10-minute grace
      window).
    - A video job is still unfinished after 2 hours.
    - An **asynchronous** image job's generation is lost mid-flight (refunded after a
      10-minute grace window, and reported as `generation_timeout`).

    Refunds are applied at most once per charge, and you never need to ask. If a
    request returns `4xx` before generation starts, nothing was charged in the first
    place.

    **One honest caveat, synchronous images only.** Video jobs and async image jobs are
    both swept by a background reconciler, so their charges are closed out even if
    nothing ever polls them. A *synchronous* image refund runs inline in the request
    that failed, and there is no row to sweep. If that request's process dies before it
    can refund — an instance lost mid-flight, a deploy landing at the wrong moment, the
    300-second ceiling reached — the charge stands with no image to show for it and
    nothing retries it. Retrying the same `Idempotency-Key` (§8) is how you resolve it
    yourself; failing that we will refund it if you tell us. **`async: true` removes
    this caveat entirely** — it is the reason to prefer it beyond the timeouts.

    ---

    ## 8. Idempotency

    Send an `Idempotency-Key` header on every `POST`. It is optional, but without one
    a retried request is a second charge.

    ```
    Idempotency-Key: order-8891-clip-1
    ```

    8–200 characters from printable ASCII `!` through `~` — **space is not allowed**,
    nor are tabs, newlines, or any non-ASCII byte. A malformed key is rejected with
    `400` rather than ignored: if you sent a key you are relying on it, so silently
    dropping it would be worse than failing.

    Both `POST` endpoints put an `Idempotency-Replay: true|false` header on every
    success response, whether or not you sent a key. Error responses do not carry it.

    Semantics:

    - **Same key, replayed after the first request succeeded** → the original result.
      Same `id`, same `credits_charged`, no second charge, no second generation, and
      for videos and async images the original job's real status and parameters.
    - **Same key, replayed while the first request is still in flight** → for videos
      and async images, the original job (the charge and its row land before we
      respond, so the id already exists — an async replay is a `202` with the same
      `poll_url`, never the synchronous `200`, because only the job id is pollable).
      For synchronous images, `409 request_in_progress` — the image is not stored yet,
      and we will not invent a result or charge you twice. Retry the same key in a few
      seconds.
    - **Same key, different body** → the original result. The key is the identity of
      the request; we do not re-generate with new parameters under an old key. Use a
      new key when the parameters change.
    - **Keys are scoped to your account and to the endpoint**, and never expire. The
      same raw key on `/videos` and on `/images` is two independent keys. Reusing a
      key from last month returns last month's result, so derive keys from something
      already unique on your side (`order-8891-clip-1`), not from a timestamp.

    ### After a client-side timeout on a synchronous image

    This is the case a 60-second default client timeout puts you in, and the reason to
    send `async: true` instead. If it happens anyway: **retry the exact same
    `Idempotency-Key`.** That one call tells you everything and cannot cost you twice.

    - The generation had in fact succeeded → you get `200` with the original
      `image_url`, `Idempotency-Replay: true`, and no second charge. You were charged
      once, and here is what for.
    - The generation had failed → that attempt already refunded itself and released
      the key, so your retry is a genuine fresh attempt at the normal price.
    - It is still running → `409 request_in_progress`. Wait a few seconds and retry the
      same key again; you have lost nothing.

    The one thing not to do is retry with a *new* key: that is a second charge for the
    same image. Never derive the key from a timestamp or a random value, or a retry
    cannot be recognised as one.

    ### After a failure

    The endpoints deliberately differ, because the useful answer differs.

    - **Images**, both modes. A failed attempt *releases* its key once the refund
      lands, so retrying the same key is a genuine new attempt. You are not billed
      twice: the first charge was already refunded.
    - **Videos.** A failed job *keeps* its key. Retrying returns that failed job with
      a `202` and its `error` code — informative, but it will never become
      `completed`. **Use a new `Idempotency-Key` to try again.**

    Idempotency covers the *charge*, which is the part that costs money. It does not
    deduplicate at the network layer: two requests fired in the same millisecond
    still both reach us, but only one of them pays.

    ---

    ## 9. Rate limits

    Two independent mechanisms. The spend caps in §1 are the real ceiling; this is a
    burst guard.

    | Scope | Bucket | Limit |
    |---|---|---|
    | `POST /api/v1/videos` | per API key | 3 immediately, then 1 per 100 s |
    | `POST /api/v1/images` | per API key | 3 immediately, then 1 per 100 s |
    | `GET /api/v1/videos/{id}` | — | not rate-limited |
    | `GET /api/v1/images/{id}` | — | not rate-limited |
    | `GET /api/v1/me` | — | not rate-limited |

    It is a token bucket of capacity 3 refilling at 3 tokens per 300 seconds. The two
    `POST` endpoints have **separate buckets**, so images do not consume the video
    budget. A token is taken *after* your body validates, so a rejected `400` costs
    you nothing — neither credits nor burst budget.

    Over the limit returns `429 rate_limited` with both a `Retry-After` header and a
    `retry_after_sec` body field. Honour either.

    Two caveats worth designing around:

    - The limiter is **in-process**, not shared. On a multi-instance deployment each
      instance keeps its own bucket, so the effective limit is somewhere between 3
      and 3 × instances and is not deterministic. Treat the documented numbers as the
      guaranteed floor, not a quota you can ride.
    - The `429` from a spend cap (`daily_cap_exceeded`, `api_capacity_exceeded`)
      carries **no** `Retry-After`. Those windows are rolling 24-hour and there is no
      single correct number; back off in minutes and read `daily_cap_remaining` from
      `GET /api/v1/me`.

    ---

    ## 10. Errors

    Every error is JSON with a stable `error` code **and** a human `message`. Match on
    `error`, never on `message` — the codes are stable, the prose is not.

    ```json
    {
      "error": "insufficient_credits",
      "message": "You need 315 credits but have 45. Top up or upgrade your plan.",
      "balance": 45,
      "needed": 315
    }
    ```

    Some codes add machine-readable fields: `issues[]` on `invalid_request`,
    `balance`/`needed` on `insufficient_credits`, `spent`/`cap` on
    `daily_cap_exceeded`, `retry_after_sec` on `rate_limited`, and `reference_url` on
    every `reference_*` code, naming which of your URLs was the problem.

    Codes are **not** global — each applies only where listed.

    | Status | `error` | Where | Meaning |
    |---|---|---|---|
    | 400 | `invalid_request` | both POSTs | Body failed validation. `issues[]` holds up to 5 `{ "field": "...", "message": "..." }` objects. |
    | 400 | `invalid_idempotency_key` | both POSTs | Not 8–200 printable ASCII, space excluded. |
    | 400 | `prompt_rejected` | `POST /images` | The content filter refused this prompt. Credits were refunded. Change the prompt. |
    | 400 | `reference_url_rejected` | both POSTs | A reference URL is not an `https` URL we will fetch: wrong scheme, a host that resolves to a private address, or a redirect. Nothing was charged. |
    | 400 | `reference_unfetchable` | both POSTs | We reached the network but got no image: a non-2xx status, a connection failure, or a timeout. Nothing was charged. |
    | 400 | `reference_type_unsupported` | both POSTs | Not `image/png`/`image/jpeg`/`image/webp`, or the bytes do not match the declared type. Nothing was charged. |
    | 400 | `reference_too_large` | both POSTs | A reference exceeded 20 MB, or all of them together exceeded 64 MB. Nothing was charged. |
    | 400 | `mask_invalid` | `POST /images` | The `mask` is not a PNG with alpha, is 4 MB or more, or does not match the first reference's dimensions. Carries `mask_url`. Nothing was charged. |
    | 401 | `unauthorized` | everywhere | Missing, malformed, unknown, or revoked API key. |
    | 402 | `insufficient_credits` | both POSTs | Includes `balance` and `needed`. Top up and retry. |
    | 404 | `not_found` | both `GET /{id}`s | No such generation for this account — including a malformed id. |
    | 409 | `request_in_progress` | both POSTs | Another request with this `Idempotency-Key` has not finished. Retry the same key in a few seconds. |
    | 429 | `rate_limited` | both POSTs | Burst limit (§9). Honour `Retry-After`. |
    | 429 | `model_busy` | `POST /api/v1/videos` | Every slot on that model is busy. Nothing charged. Honour `Retry-After`, or submit against another model. |
    | 429 | `daily_cap_exceeded` | both POSTs | This key hit its rolling 24-hour credit cap. Includes `spent` and `cap`. Raise the cap in the dashboard or wait. |
    | 429 | `api_capacity_exceeded` | both POSTs | Platform-wide daily limit. Not your fault; retry later. |
    | 500 | `internal` | everywhere | Our bug, and logged as one. Usually nothing was charged; on the rare variant that fails *after* the charge we cannot promise the automatic refund, so check `GET /api/v1/me` and tell us if your balance looks wrong. |
    | 502 | `upstream_error` | both POSTs | Generation failed, or succeeded and could not be delivered. Credits were refunded. Safe to retry. |
    | 502 | `configuration_error` | `POST /images` | **Our misconfiguration**, not your prompt. Credits were refunded. Retrying will not help until we fix it — tell us. |
    | 503 | `service_unavailable` | everywhere | Generation or storage is temporarily offline, or our provider account is. Credits, if any were taken, were refunded. |

    `configuration_error` exists because it used to be reported as
    `prompt_rejected`. Any provider `400` — an unsupported parameter, a model we had
    misnamed, an account-verification failure — was blamed on the caller's prompt
    and the caller went looking for a content filter that was never involved. If you
    receive `prompt_rejected` now, moderation genuinely refused; if the problem is
    ours you will be told so.

    ### Failed video jobs

    A failed video reports its reason in the `error` field of `GET
    /api/v1/videos/{id}` — and of a `POST /api/v1/videos` replay — rather than at the
    HTTP layer, since the request that fetched it succeeded:

    | `error` | Meaning |
    |---|---|
    | `prompt_rejected` | The content filter refused it — the same code and the same meaning as on `POST /images`. **Change the prompt** (or the reference images); resubmitting the same request will fail the same way. |
    | `generation_rejected` | The provider refused the submission outright. |
    | `generation_failed` | Generation started and did not produce a usable clip. Nothing about your request is known to be wrong — retrying is reasonable. |
    | `generation_timeout` | The job never finished (closed out after 2 hours). |
    | `storage_failed` | Generated, but we could not store it. |
    | `footage_unreadable` | Motion graphics with footage only: the footage could not be downloaded, read or transcribed. |
    | `submit_unconfirmed` | Our submission was never acknowledged, so we could not tell whether it was accepted. Closed out after a 10-minute grace window. |
    | `duplicate_request` | Another request with the same `Idempotency-Key` won the race; that one is the real job. |

    All of these are refunded. All of them require a **new** `Idempotency-Key` to try
    again (§8).

    ### Failed image jobs

    On the synchronous path a generation failure is the HTTP response, with the codes
    above. On the asynchronous path the `POST` already returned `202`, so the same
    codes arrive in the `error` field of `GET /api/v1/images/{id}` instead — identical
    meanings, identical refunds:

    | `error` | Meaning |
    |---|---|
    | `prompt_rejected` | The content filter refused this prompt. Change it. |
    | `configuration_error` | Our misconfiguration, not your prompt. Retrying will not help until we fix it. |
    | `upstream_error` | Generation failed, or succeeded and could not be stored. Safe to retry. |
    | `service_unavailable` | Our provider account or storage was unavailable. Retry later. |
    | `generation_timeout` | The generation was lost mid-flight and closed out by the sweeper after 10 minutes. Safe to retry. |

    All of these release their `Idempotency-Key`, so retrying with the **same** key is
    a genuine fresh attempt (§8) — the opposite of the video rule.

    ---

    ## 11. Versioning and stability

    `/api/v1` is stable. While it is v1 we will:

    - add response fields, add optional request fields, add new `error` codes, and
      add new endpoints — **without notice**;
    - never remove or repurpose a documented response field, never change the meaning
      of an existing `error` code, never make an optional request field required,
      and never change a price without notice in `docs/pricing.md`.

    So: parse leniently, ignore fields you do not recognise, and treat an unknown
    `error` code by falling back on the HTTP status class. A breaking change means
    `/api/v2` alongside `/api/v1`, not a change under your feet.

    Provider neutrality is part of the contract. Which upstream models we use is
    deliberately not documented and not observable from a response, and we reserve
    the right to change them. If you need a specific named model, this is not the
    right API.

    ---

    ## 12. Putting it together

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

    # 30-120s is typical; 5s polling is plenty and GETs are not rate-limited.
    for _ in $(seq 1 60); do
      body=$(curl -sS "https://sociafy.app/api/v1/videos/$id" -H "Authorization: Bearer $KEY")
      status=$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
      [ "$status" = "pending" ] || { printf '%s\n' "$body"; exit 0; }
      sleep 5
    done

    echo "still pending after 5 minutes" >&2; exit 1
    ```

    Re-running the script with the same `IDEM` is free and returns the same clip — as
    long as it succeeded. If it ended `failed`, change `IDEM` before retrying, or you
    will keep being handed the same dead job (§8).

    Images take the identical shape once you send `"async": true` — same `202`, same
    `poll_url`, same loop, and no client timeout to tune:

    ```bash
    id=$(curl -sS -X POST https://sociafy.app/api/v1/images \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -H "Idempotency-Key: $IDEM-hero" \
      -d '{"prompt":"overhead flat-lay of a matcha latte on warm oak","async":true}' \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

    # 70-90s is typical. Same loop as above against /api/v1/images/$id; on
    # "completed" take image_url, on "failed" read error — credits are already back.
    ```

    Unlike video, retrying a *failed* image with the same `IDEM` is correct and is a
    real new attempt (§8).

    Submitting several clips? Space the `POST`s out, or expect `429 rate_limited`
    after the third (§9).

    ---

    ## 13. Not in v1

    Named so you build around them rather than waiting:

    - **Outbound webhooks.** Poll instead; at this volume it is cheaper for both of
      us than you operating a public endpoint.
    - **Reference *video* on `POST /api/v1/videos`.** See §4 — a pricing correctness
      problem, not an effort one. Still images (`reference` and `image-to-video`) do
      exist, and cost no more than text-to-video.
    - **Batch parameters.** One request, one job, one charge. Loop.
    - **Streaming or progress percentages.** `status` is `pending` until it isn't.
    - **Programmatic key management.** Session-only, see §1.
    - **CORS / browser access.** Server-to-server only.
    - **A refund sweeper for *synchronous* images.** There is nothing to sweep — the
      row that makes one possible is what `async: true` creates. See §7.
    - **A likeness/fidelity parameter for images.** The model does not support one;
      see §6.
    - **Postpaid billing.** Prepaid credits are also the spend cap; a balance cannot
      go negative.

    ---

    ## 14. Text and vision: `POST /api/v1/chat/completions`

    Text generation (chat, captions, content plans, prompt rewriting) and image
    understanding (describe a product photo, pick where a logo fits) through one
    endpoint, metered per call against the same credit balance.

    **OpenAI-compatible request and response.** Code written against the OpenAI
    chat-completions API switches by changing two things: the base URL to
    `https://sociafy.app/api/v1` and the key to your `sfy_live_…` key — plus the
    `model` string (below). Errors keep this API's own envelope (§10), not OpenAI's.

    ```js
    const client = new OpenAI({ baseURL: 'https://sociafy.app/api/v1', apiKey: process.env.SOCIAFY_API_KEY });
    const r = await client.chat.completions.create({ model: 'sociafy-chat-1', messages });
    ```

    ### Text

    ```bash
    curl -sS -X POST https://sociafy.app/api/v1/chat/completions \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "sociafy-chat-1",
        "messages": [
          {"role": "system", "content": "You write Instagram captions for a fine-jewellery brand. Warm, under 40 words."},
          {"role": "user", "content": "Caption for our new 18k gold hoop earrings."}
        ],
        "max_tokens": 300
      }'
    ```

    ```json
    {
      "id": "chatcmpl-6f0c…",
      "object": "chat.completion",
      "created": 1791000000,
      "model": "sociafy-chat-1",
      "choices": [
        {
          "index": 0,
          "message": { "role": "assistant", "content": "Everyday gold, made to be noticed…", "refusal": null },
          "finish_reason": "stop"
        }
      ],
      "usage": {
        "prompt_tokens": 41,
        "completion_tokens": 38,
        "total_tokens": 79,
        "completion_tokens_details": { "reasoning_tokens": 0 }
      },
      "credits_charged": 1
    }
    ```

    `credits_charged` is the only field OpenAI does not send; OpenAI clients ignore it.

    ### JSON output

    `response_format` is passed through: `{"type": "json_object"}` (say "JSON" in a
    message, as the model requires) or `{"type": "json_schema", "json_schema": {…}}`
    for a schema the answer must follow. Parse `choices[0].message.content`.

    ```bash
    curl -sS -X POST https://sociafy.app/api/v1/chat/completions \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "messages": [
          {"role": "system", "content": "Return JSON only."},
          {"role": "user", "content": "Plan 3 posts for Diwali week: {\"posts\":[{\"day\":\"\",\"idea\":\"\"}]}"}
        ],
        "response_format": {"type": "json_object"}
      }'
    ```

    ### An image question

    User messages may be an array of parts: `{"type": "text", "text": "…"}` and
    `{"type": "image_url", "image_url": {"url": "…", "detail": "auto|low|high"}}`.
    The `url` is either a public `https://` URL or a `data:image/…;base64,…` URL.

    ```bash
    curl -sS -X POST https://sociafy.app/api/v1/chat/completions \
      -H "Authorization: Bearer $SOCIAFY_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "messages": [{
          "role": "user",
          "content": [
            {"type": "text", "text": "Which corner of this photo is emptiest for a logo? Answer top-left, top-right, bottom-left or bottom-right."},
            {"type": "image_url", "image_url": {"url": "https://cdn.example.com/products/ring-042.jpg"}}
          ]
        }],
        "max_tokens": 50
      }'
    ```

    Images follow the reference-image rules of §6: https only, no redirects, no
    private hosts, `image/png`, `image/jpeg` or `image/webp` with matching bytes,
    20 MB each. On top of that: **at most 4 images per request and 20 MB in total**.
    We fetch https URLs ourselves and never hand your URL to anyone else. A bad image
    is a `400` with a `reference_*` code (§10) — `reference_url` names the https URL
    at fault, `image_index` (0-based, in message order) the image — and nothing is
    charged.

    ### Fields

    - `messages` (required) — 1–100 messages with role `system`, `developer`,
      `user` or `assistant`. Only `user` messages may contain images. At most
      200,000 characters of text in total.
    - `model` — `sociafy-chat-1` (default; best writing) or `sociafy-chat-1-mini`
      (faster, cheaper on long outputs). Any other value is a `400`.
      `GET /api/v1/models` lists both with `type: "chat"`.
    - `max_tokens` / `max_completion_tokens` — output budget, 1–8,192, default
      4,096. Includes any reasoning tokens.
    - `reasoning_effort` — `minimal` (default), `low`, `medium`, `high`. Higher
      thinks longer and bills more output tokens.
    - `temperature` — accepted for compatibility; the current models ignore it.
    - `response_format` — as above.
    - `stream` — **not supported**; `stream: true` is a `400`. `n` must be 1.
      `tools` / `functions` are a `400`. Other OpenAI fields (`user`, `seed`, …)
      are accepted and ignored.

    ### Cost

    Metered from the call's **actual** token usage, which comes back in `usage`.
    Image inputs are counted inside `prompt_tokens`; reasoning inside
    `completion_tokens`. Credits = provider cost × 112.5 per US dollar, **rounded up,
    minimum 1 credit per call**. Per million tokens, that is:

    | Model | Input | Output |
    |---|---|---|
    | `sociafy-chat-1` | 140.6 credits | 1,125 credits |
    | `sociafy-chat-1-mini` | 28.1 credits | 225 credits |

    So a 1,500-token-in / 500-token-out caption on `sociafy-chat-1` is 0.77 →
    **1 credit**; a question about one product photo (≈1,400 tokens in, 400 out) is
    also **1 credit**; a 3,000-in / 4,000-out content plan is **5 credits**. The
    exact figure is `credits_charged`.

    Because usage is only known afterwards, we first check that your balance covers
    the request's *worst case* (all of `max_tokens` used, every image at its
    largest) and answer `402 insufficient_credits` if not — nothing is called or
    charged. Lower `max_tokens` if a small balance trips that check. The charge itself
    is the actual usage, taken after the answer is generated.

    **A failed call is never charged**, so there is nothing to refund: provider
    errors answer `502 upstream_error`, `502 configuration_error` or
    `503 service_unavailable` (also when the model is momentarily busy), a
    request the model refuses as too long or malformed is `400 invalid_request`,
    and a content-filter refusal is `400 prompt_rejected` — all uncharged.

    ### Idempotency and rate limit

    `Idempotency-Key` works as in §8, scoped to this endpoint: a replay of a
    successful call returns the identical response (`Idempotency-Replay: true`) with
    no second charge. Since a failed call charges nothing, it also never consumes its
    key — retrying the same key after a failure is a real new attempt. Responses are
    stored for replay only when you send a key.

    Rate limit: per API key, 60 immediately, then 1 per second — separate from the
    image and video buckets. The daily spend caps of §1 apply as to every `POST`.
