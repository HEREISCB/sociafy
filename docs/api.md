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
    charged. Reference images make it worse: up to 20 MB each and 48 MB per request,
    uploaded before generation starts.

    If you stay synchronous, **set your client timeout to at least 180 seconds**, and
    read §7 — a timed-out request's charge is recoverable by retrying the same
    `Idempotency-Key`. `POST /api/v1/videos` returns in a second or two; none of this
    is about it.

    We may make `async: true` the default in a future version of this API, announced
    before it happens. Sending it explicitly today is how you become immune to that.

    ---

    ## 1. Authentication

    Every request needs a Bearer API key. Create one in your dashboard under
    **Account → API** (`/developers`), which is also where this reference, the
    quickstart, the prices and the limits are rendered in-app; the plaintext key is
    shown exactly once.

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
      key's cap in place under Account → API.

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
    hours: refunds (see §6) are subtracted, so a run of failed generations does not
    burn your daily cap. It is the same figure the cap is enforced against, so
    `daily_cap_remaining` is exactly how much you can still spend.

    Status codes: `200`, `401`, `500`, `503`.

    ---

    ## 3. `POST /api/v1/videos`

    Submit a video generation — from a prompt alone, or from still images of the
    real thing. Returns `202` immediately — generation takes 30–120 seconds, so you
    poll (§4) rather than holding a connection open.

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
    | `gen_mode` | `text` \| `reference` \| `image-to-video` | `text` | Which still images, if any, the clip is built from. See below. |
    | `reference_images` | array of 1–4 `https` URLs | omitted | **`gen_mode: "reference"` only, and required by it.** Photos of the real subject, so the clip shows *your* product rather than an approximation of it. |
    | `start_frame` | `https` URL | omitted | **`gen_mode: "image-to-video"` only, and required by it.** The clip's first frame. |
    | `end_frame` | `https` URL | omitted | `gen_mode: "image-to-video"` only. The clip's last frame, if you want to pin where it lands. |

    **Unknown fields are rejected with `400`.** A typo in `quality` should not
    silently bill you for a default you did not choose.

    `status`, `duration_sec`, `quality` and `aspect` always describe the **stored
    job**, which matters on an idempotent replay: replaying a key whose job already
    finished returns that job's real status and its original parameters, not the
    parameters you just sent. A replay that resolves to a `failed` job also carries
    an `error` field with the same code `GET /api/v1/videos/{id}` would give, so you
    do not go off and poll something that can never succeed.

    `202` is returned on both a fresh submit and a replay.

    Generate several clips by making several requests, each with its own
    `Idempotency-Key`. There is no `count` parameter — one request is one job, one
    charge, one id. **Mind the burst limit while you do** (§8): three submits, then
    one every 100 seconds. A batch of ten clips takes about fifteen minutes to get
    in the door.

    ### Still images as input

    Two modes take images, and both cost **exactly the same as text-to-video** — the
    provider prices video per output second, and still input adds nothing to that, so
    there is no surcharge to pass on. Compare `reference_images` on `POST
    /api/v1/images`, which does carry one (§6), because that provider bills input
    image tokens.

    - **`gen_mode: "reference"`** with `reference_images`: 1–4 photos of the real
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
    those in §5 (`https` only, no redirects, publicly resolvable host, `png`/`jpeg`/
    `webp` verified by magic bytes, 20 MB each and 48 MB in total, 20 s each and 45 s
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

    ## 4. `GET /api/v1/videos/{id}`

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
      "status": "completed",
      "video_url": "https://<your-media-host>/users/user_2ab.../vid-1753538201-9f3c.mp4",
      "credits_charged": 180,
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

    ## 5. `POST /api/v1/images`

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
    out by replaying the key (§7).

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
    `pending`. A `failed` job names its reason in `error` (§9) and
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
    | `prompt` | string, 2–2000 chars | required |
    | `size` | `1024x1024` \| `1536x1024` \| `1024x1536` | `1024x1024` |
    | `quality` | `low` \| `medium` \| `high` | `medium` |
    | `reference_images` | array of 1–4 `https` URLs — see below | omitted |
    | `async` | boolean — `true` returns `202` + `poll_url` instead of holding the connection open | `false` |

    Unknown fields are rejected with `400`, and there is no `count` — one request,
    one image, one charge. Everything else is identical between the two modes: same
    validation, same prices, same refunds, same idempotency, same reference-image
    handling.

    **Timing.** Text-only, `quality: "medium"` has been measured at **66–78 seconds**
    across five runs; with one reference image, **about 83 s**. `high` is
    slower, `low` is faster. References add up to 45 seconds of fetching plus the time
    to upload up to 48 MB of them, so plan for **up to ~3 minutes** on that path.
    Asynchronously none of that reaches your client, which sees a `202` in under a
    second. **Synchronously it is all wall-clock time on your socket:** the request is
    held open for up to 300 seconds, so set your client timeout to at least 180 s — a
    60-second default fails on almost every request. If the connection ends without a
    result, retry the same `Idempotency-Key` (§7) to find out whether you were
    charged; the refund caveat in §6 also applies to that path only.

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
    angles rather than a bigger file: see the token table in §6 for why resolution
    does not help.

    Requirements, each of which is a distinct `400` if unmet:

    | Requirement | Why |
    |---|---|
    | `https` only, no redirects | We fetch these ourselves. `http` and a redirect chain are both refused; send the final URL. |
    | Publicly resolvable host | Private, loopback, link-local and metadata addresses are blocked in every notation. |
    | `image/png`, `image/jpeg` or `image/webp` | And the bytes must match the header — we check the magic bytes, not your `content-type`. |
    | Under 20 MB each, 48 MB in total | Enforced while downloading, so a missing or dishonest `content-length` does not help. We buffer every reference in memory at once, which is what the shared budget bounds — not the price. |
    | Reachable within 20 s each, 45 s in total | A slow host costs you the whole request. |

    URLs on our own media host are held to exactly the same checks — hosting an
    object says nothing about its size or its contents.

    There is **no megapixel limit and no dimension requirement**. Both used to exist,
    purely to bound a per-megapixel charge that no longer exists (§6), so an image we
    cannot measure is no longer refused.

    Cost: the output price from §6 **plus a flat surcharge per reference image**,
    independent of its resolution. Nothing changes for a request without
    `reference_images`.

    ---

    ## 6. Credit costs

    Charged at submission. Nothing else on the request is billable — no charge for
    polling, for `GET /api/v1/me`, or for a request rejected with
    `400`/`401`/`404`/`429`.

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

    **Video reference stills** (`reference_images`, `start_frame`, `end_frame`):
    **no surcharge.** The provider prices video per second of *output*; still input
    does not enter into it, so `gen_mode: "reference"` and `gen_mode:
    "image-to-video"` cost exactly what the same clip costs from a prompt alone. The
    only input that would be surcharged is a reference *video*, which is why that one
    is not offered (§3).

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
    request body before you send it: output tier + 6 × `len(reference_images)`.

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
    nothing retries it. Retrying the same `Idempotency-Key` (§7) is how you resolve it
    yourself; failing that we will refund it if you tell us. **`async: true` removes
    this caveat entirely** — it is the reason to prefer it beyond the timeouts.

    ---

    ## 7. Idempotency

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

    ## 8. Rate limits

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

    ## 9. Errors

    Every error is JSON with a stable `error` code **and** a human `message`. Match on
    `error`, never on `message` — the codes are stable, the prose is not.

    ```json
    {
      "error": "insufficient_credits",
      "message": "You need 180 credits but have 45. Top up or upgrade your plan.",
      "balance": 45,
      "needed": 180
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
    | 400 | `reference_too_large` | both POSTs | A reference exceeded 20 MB, or all of them together exceeded 48 MB. Nothing was charged. |
    | 401 | `unauthorized` | everywhere | Missing, malformed, unknown, or revoked API key. |
    | 402 | `insufficient_credits` | both POSTs | Includes `balance` and `needed`. Top up and retry. |
    | 404 | `not_found` | both `GET /{id}`s | No such generation for this account — including a malformed id. |
    | 409 | `request_in_progress` | both POSTs | Another request with this `Idempotency-Key` has not finished. Retry the same key in a few seconds. |
    | 429 | `rate_limited` | both POSTs | Burst limit (§8). Honour `Retry-After`. |
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
    | `submit_unconfirmed` | Our submission was never acknowledged, so we could not tell whether it was accepted. Closed out after a 10-minute grace window. |
    | `duplicate_request` | Another request with the same `Idempotency-Key` won the race; that one is the real job. |

    All of these are refunded. All of them require a **new** `Idempotency-Key` to try
    again (§7).

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
    a genuine fresh attempt (§7) — the opposite of the video rule.

    ---

    ## 10. Versioning and stability

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

    ## 11. Putting it together

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
    will keep being handed the same dead job (§7).

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
    real new attempt (§7).

    Submitting several clips? Space the `POST`s out, or expect `429 rate_limited`
    after the third (§8).

    ---

    ## 12. Not in v1

    Named so you build around them rather than waiting:

    - **Outbound webhooks.** Poll instead; at this volume it is cheaper for both of
      us than you operating a public endpoint.
    - **Reference *video* on `POST /api/v1/videos`.** See §3 — a pricing correctness
      problem, not an effort one. Still images (`reference` and `image-to-video`) do
      exist, and cost no more than text-to-video.
    - **Batch parameters.** One request, one job, one charge. Loop.
    - **Streaming or progress percentages.** `status` is `pending` until it isn't.
    - **Programmatic key management.** Session-only, see §1.
    - **CORS / browser access.** Server-to-server only.
    - **A refund sweeper for *synchronous* images.** There is nothing to sweep — the
      row that makes one possible is what `async: true` creates. See §6.
    - **A likeness/fidelity parameter for images.** The model does not support one;
      see §5.
    - **Postpaid billing.** Prepaid credits are also the spend cap; a balance cannot
      go negative.
