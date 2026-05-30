# Voice & Avatar Studio — Design

_Date: 2026-05-30 · Status: awaiting review_

Add two coupled AI capabilities to Sociafy, shipped together in one release:

1. **Voice Twin** — zero-shot voice cloning. A user uploads/records a short clip of
   **their own** voice, passes a consent gate, and gets a reusable voice they can use
   for text-to-speech and to drive avatars.
2. **Avatar** — a talking-head video generation mode inside the existing video studio.
   A face photo + a script (spoken in the user's Voice Twin, or uploaded audio) →
   a lip-synced talking video that is published exactly like any other generated clip.

Both run as **serverless GPU services on Modal** (workspace `cbmix-com`). The Next.js
app never runs the models; it submits jobs to Modal web endpoints and polls, mirroring
the existing PiAPI/Seedance `videoJobs → poll → R2 → mediaAssets` pattern. PiAPI is
untouched and remains the Seedance backend.

---

## 1. Naming & non-exposure rules (hard requirement)

The underlying open models must **never** be named in any user-facing surface: UI labels,
tooltips, network responses, error messages, analytics events, or generated metadata.

| Concept | User-facing name | Internal code module | Underlying model (never shown) |
|---|---|---|---|
| Voice cloning | **Voice Twin** / "Voice Studio" | `voice-engine` | OmniVoice (k2-fsa) |
| Talking avatar | **Avatar** | `avatar-engine` | LongCat-Video-Avatar 1.5 (Meituan) |

- API error codes are generic (`voice_engine_unavailable`, `avatar_engine_failed`) — no
  model identifiers.
- The Modal app names are `sociafy-voice-engine` and `sociafy-avatar-engine`.
- Provider strings stored in the DB are `modal-voice` / `modal-avatar` (not model names).

These names are easily changed; they are the working defaults.

---

## 2. Goals & non-goals

**Goals**
- Voice cloning with a consent + responsibility gate and an audit trail.
- Avatar video that speaks in the user's own voice and matches a chosen face.
- Avatar appears as a natural extension of the existing video studio — no new mental model.
- Reuse the existing async job → poll → R2 → credits → refund machinery.
- Stub mode (no Modal keys) keeps the whole app runnable locally, per existing philosophy.

**Non-goals (this release)**
- Real-time / streaming TTS.
- Multi-speaker avatar scenes (the engine supports it; deferred).
- Voice marketplace / sharing voices between users.
- Voice-captcha liveness verification (noted as future abuse-hardening).

---

## 3. Architecture

```
Next.js (Vercel, serverless)                    Modal (GPU, scale-to-zero)
POST /api/voices ─────────────────────────────► voice-engine  /voice/prepare   (sync: Whisper transcribe + validate)
POST /api/tts ──────────────► genJob(tts) ─────► voice-engine  /tts/submit  → /tts/result/{id}
POST /api/media/generate-avatar ─ genJob(avatar)► avatar-engine /avatar/submit → /avatar/result/{id}
GET  /api/media/gen-job/[id] (client polls) ───► engine /…/result/{id}
        └─ on done: result already in R2 → write mediaAssets row → settle credits
```

- **Modal services** use `@modal.cls` with `@modal.enter()` to load weights once per
  warm container. Weights live in a **Modal Volume** (downloaded once via
  `huggingface-cli`, not re-pulled per cold start).
- **Long jobs** use Modal `.spawn()` returning a `call_id`; the `/…/result/{call_id}`
  endpoint reports `pending | done | failed`. TTS is fast and usually resolves in 1–2
  polls; avatar takes minutes.
- **Auth**: every Modal web endpoint requires a `X-Engine-Secret: <MODAL_WEBHOOK_SECRET>`
  header. Requests without it are rejected. The secret is shared between Vercel env and a
  Modal Secret.
- **Output handoff**: the Modal job uploads its finished artifact **directly to R2**
  (R2 creds provided to Modal as a Modal Secret) and the result endpoint returns the R2
  public URL. The Next.js poller then only writes the `mediaAssets` row and settles
  credits — no download hop. (This differs from the Seedance finalize, which downloads
  from PiAPI's CDN because PiAPI owns that storage.)

### 3.1 Avatar is a single pipeline

When the avatar request includes `voiceId + script` (the common path), the
`avatar-engine` performs the whole pipeline inside one job:

1. Synthesize speech from the Voice Twin reference + script (calls the voice model,
   co-located in the same Modal app or invoked as a Modal function).
2. Animate the face photo to that speech → talking video.
3. Upload the MP4 to R2; return URL.

So the user waits on **one** job, not two. If the request instead supplies `audioUrl`
(user-uploaded audio), step 1 is skipped.

---

## 4. Modal services

### 4.1 `sociafy-voice-engine`
- **GPU**: `L4` or `A10G` (the model is 0.6B; small GPU is plenty). Default `L4`.
- **Endpoints**:
  - `POST /voice/prepare` (sync) — body `{ refAudioUrl }`. Downloads the clip, validates
    format/duration (8–60s), runs Whisper transcription, returns
    `{ ok, durationS, transcript, language, sampleRate }` or a typed error
    (`too_short`, `too_long`, `no_speech`, `multi_speaker_suspected`).
  - `POST /tts/submit` — body `{ refAudioUrl, refText, text, options }`. `.spawn()`s the
    synthesis, returns `{ callId }`.
  - `GET /tts/result/{callId}` — `{ status, audioUrl?, error? }`. Output is a 24 kHz WAV
    (or MP3) uploaded to R2.
- Loads OmniVoice + faster-whisper in `@modal.enter()`.

### 4.2 `sociafy-avatar-engine`
- **GPU**: `H100` (80 GB) with `--use_int8 --use_distill` (8-step distilled). Fallback to
  `2× A100-80GB` (`context_parallel_size=2`) if a single H100 can't hold the 1.5 model —
  decided by a benchmark during build (§10).
- **Endpoints**:
  - `POST /avatar/submit` — body
    `{ imageUrl, script?, voice?:{refAudioUrl,refText}, audioUrl?, prompt?, aspect, quality, expressive? }`.
    `.spawn()`s the pipeline, returns `{ callId }`.
  - `GET /avatar/result/{callId}` — `{ status, videoUrl?, error? }`. Output is an MP4 in R2.
- Resolution capped to **480p / 720p** (engine supports both; 1080p not offered).
- Audio CFG fixed in the recommended 3–5 range; `num_segments` derived from script length.

### 4.3 Secrets / config (Modal side)
- Modal Secret `sociafy-r2`: R2 account id, access key, secret, bucket, public base.
- Modal Secret `sociafy-engine`: `ENGINE_SECRET` (matches Vercel `MODAL_WEBHOOK_SECRET`).

---

## 5. Reference-audio spec (researched)

OmniVoice is **zero-shot**: one clean clip + its transcript (auto-transcribed by Whisper)
is the "voice profile". Best practice (ElevenLabs IVC): cleanliness matters more than
length; >3 min gives no benefit.

- **Accepted**: 8–60 s, mono or stereo, WAV/MP3/M4A/OGG, ≤ 50 MB (reuses the existing
  audio upload limit in compose).
- **Recommended in UI**: 20–40 s of clean, single-speaker speech, no music/reverb.
- Server stores the clip in R2 + the transcript; both are passed to the engine at
  synthesis time. No long-running "training" — the profile is just (audio + transcript).

---

## 6. Data model (Drizzle; migration applied via Supabase SQL editor per project workflow)

### 6.1 `voices`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `userId` | text | Clerk user id |
| `name` | text | user-given label, e.g. "My voice" |
| `status` | text | `preparing` \| `ready` \| `failed` |
| `refStorageKey` | text | R2 key of reference clip |
| `refPublicUrl` | text | |
| `refDurationS` | numeric | |
| `transcript` | text | Whisper transcript of the reference |
| `language` | text | detected language code |
| `consentVersion` | text | version of consent text accepted |
| `consentSignature` | text | typed legal name |
| `consentAcceptedAt` | timestamptz | |
| `error` | text | failure reason if `failed` |
| `createdAt` | timestamptz | |

Index on `userId`.

### 6.2 `genJobs` (generic Modal job; `videoJobs` stays as-is for Seedance)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `userId` | text | |
| `kind` | text | `tts` \| `avatar` |
| `provider` | text | `modal-voice` \| `modal-avatar` |
| `providerCallId` | text | Modal `call_id` |
| `status` | text | `pending` \| `completed` \| `failed` |
| `inputJson` | jsonb | request params (voiceId, script, imageUrl, options…) |
| `mediaAssetId` | uuid | set on completion |
| `error` | text | |
| `creditLedgerId` | uuid | for refunds |
| `creditsCharged` | integer | |
| `createdAt` / `updatedAt` | timestamptz | |

Indexes on `userId` and `providerCallId`.

---

## 7. API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/voices` | `GET` | list the user's voices |
| `/api/voices` | `POST` | create a Voice Twin: `{ refAudioUrl, name, consentSignature }`; validates consent, calls `/voice/prepare`, inserts `voices` row (`ready`/`failed`), charges `voice_twin_create` |
| `/api/voices/[id]` | `DELETE` | delete voice + its R2 reference asset |
| `/api/tts` | `POST` | `{ voiceId, text }` → genJob(tts); used by Voice Studio previews and standalone TTS |
| `/api/media/generate-avatar` | `POST` | `{ imageUrl, voiceId?, audioUrl?, script?, prompt?, aspect, quality, expressive? }` → genJob(avatar) |
| `/api/media/gen-job/[id]` | `GET` | poll Modal job; on `done`, write `mediaAssets`, settle credits; on `failed`, refund. Idempotent like the current video-job route |

- **Shared finalize helper** `lib/media/finalize.ts`: extract the
  `downloadToBuffer`/R2-upload/mediaAsset-insert/refund logic from the current
  `video-job/[jobId]/route.ts` so Seedance and Modal pollers share it (Seedance still
  downloads; Modal jobs already have an R2 URL and skip the download).
- **Modal client** `lib/ai/modal.ts`: TLS-hardened `https.request` wrapper (same posture
  as `piapi.ts`), `submitTts`, `getTtsResult`, `prepareVoice`, `submitAvatar`,
  `getAvatarResult`, all sending `X-Engine-Secret`.

---

## 8. UX & flows

**Guiding principle:** never make the user choose between "video" and "avatar" cold.
Avatar is one more tile in the *existing* "How to generate" grid in the video studio
(`Text · Image-to-video · Reference · Audio-driven · Avatar`). Users find it exactly
where they already make videos.

### 8.1 Avatar mode panel (progressive, three light steps — no wizard wall)
1. **Face** — pick a photo from existing media or upload one. Inline "good photo"
   checklist (front-facing, one face, even light). Shows the chosen face as a thumbnail.
2. **Voice & script** — a segmented control **[ Your Voice Twin ▾ | Upload audio ]**.
   - *Voice Twin*: dropdown of the user's ready voices + **"+ Create voice"** (opens the
     creator drawer inline). Then a script textarea with a live duration estimate.
   - *Upload audio*: the existing audio upload control; script hidden.
3. **Look** — aspect (9:16 / 1:1 / 16:9), quality (480p / 720p), optional expressive /
   motion cues (smile, nod). **Generate** button shows the exact credit cost.

The generated avatar video lands in the post's media like any Seedance clip — same
preview, same publish path. No new downstream concepts.

### 8.2 Voice Twin creator (drawer, reused everywhere)
Launched from the Avatar voice picker and from the Voices manager.
1. **Provide audio** — record in-browser (MediaRecorder) **or** upload. Waveform +
   playback. Live validation (duration in the 8–60 s window, single speaker hint).
2. **Consent screen** — the full ownership/responsibility agreement is displayed
   **before** the user can proceed ("preview the law"). To continue, the user must:
   - check **"This is my own voice. I have the right to clone it and take full
     responsibility for everything I create with it."**
   - type their **legal name** as a signature.
3. **Create** — POSTs to `/api/voices`; the row is created and transcription runs; the
   new voice appears in the picker as `preparing → ready`.

### 8.3 Voices manager
A "My Voices" surface (in the composer's voice picker, and a section in the dashboard)
to rename/delete voices and run quick text-to-speech previews via `/api/tts`.

### 8.4 Empty / first-run states
- Avatar mode with zero voices: a friendly prompt — "Create your Voice Twin to make the
  avatar speak in your voice, or upload an audio track."
- Clear, human progress copy during generation ("Bringing your avatar to life — this
  takes a couple of minutes").

---

## 9. Consent & legal

- Consent copy is versioned in code (`lib/legal/voiceConsent.ts`, e.g. `v1`). The exact
  acceptance text + version + typed signature + timestamp + userId is stored on the
  `voices` row — a complete audit trail.
- A voice-cloning clause is added to `app/legal/terms`.
- The agreement states, in plain language: the voice must be the user's own; the user is
  solely responsible for all generated content; impersonation/misuse is prohibited and
  may result in account termination and liability.
- Server re-validates that a signature is present and the consent version is current
  before creating any voice (never trust the client).

---

## 10. Pricing & credits

Cost model basis (from `docs/pricing.md`): **1 credit = $0.009 raw provider cost**, target
margin ~30%. Modal GPU rates used for estimates (verify at modal.com/pricing before
launch): L4 ≈ $0.0008/s, A10G ≈ $0.0011/s, A100-80GB ≈ $0.0019/s, H100 ≈ $0.0011/s
(per-GPU; figures approximate).

New ledger actions and **initial** credit prices:

| Action | What | Est. provider cost | Credits | Notes |
|---|---|---:|---:|---|
| `voice_twin_create` | one-time: Whisper transcribe + validate | ~$0.02 | **5** | small fee deters throwaway clones |
| `tts_synthesis` | one TTS render (≤ 60 s out) | ~$0.02 | **4** | Voice Studio preview / standalone TTS |
| `avatar_video_480p` | avatar clip ≤ 10 s, 480p | ~$0.40 (est.) | **50** | includes TTS + animation GPU time |
| `avatar_video_720p` | avatar clip ≤ 10 s, 720p | ~$0.70 (est.) | **90** | |

**Calibration step (required during build):** benchmark a representative avatar clip on
Modal, measure actual GPU-seconds, and set
`credits = ceil(measured_cost × 1.10 / 0.009)` rounded to a clean number, then update the
table above and `lib/credits/pricing.ts`. Avatar is the only uncertain figure; the
estimates above are deliberately conservative (and notably cheaper than Seedance because
we run our own GPU rather than paying PiAPI's markup).

Worst-case single avatar (720p, max length) is added to the COSTS.md monitoring table.
Credits are reserved pre-flight and refunded on job failure, exactly like Seedance.

---

## 11. Env / config

Add to `.env.example` and `.env.local`:
```
# Modal GPU engines (Voice Twin + Avatar)
MODAL_VOICE_ENGINE_URL=     # https://<workspace>--sociafy-voice-engine-<fn>.modal.run
MODAL_AVATAR_ENGINE_URL=    # https://<workspace>--sociafy-avatar-engine-<fn>.modal.run
MODAL_WEBHOOK_SECRET=       # shared secret; matches Modal Secret `sociafy-engine`
```
When these are absent → **stub mode** (§13). Modal Python lives in `modal/` in the repo
(`voice_engine.py`, `avatar_engine.py`, `common.py`), deployed with `modal deploy`.

---

## 12. Rate limits / abuse

Add to the existing `rate-limit.ts` buckets:
- `voiceCreate`: 5 / hour / user
- `tts`: 10 / min / user
- `avatarGen`: 2 / min / user (and tier-gate 720p if desired, matching video policy)

Consent gate + audit log is the primary abuse guardrail. Voice-captcha liveness is a
documented future hardening step.

---

## 13. Stub mode

With no Modal env vars set, the routes return deterministic fake assets (a placeholder
WAV / a sample MP4 from `public/`) so the full compose → avatar → publish flow runs
locally without GPUs. Mirrors the existing PiAPI/OpenAI stub philosophy.

---

## 14. Testing (Vitest + Modal smoke)

- `pricing.ts`: new action costs + reservation/refund math.
- Consent validation: missing signature / stale version rejected.
- `gen-job` finalize: completed → mediaAsset; failed → refund; idempotent double-poll.
- Modal client: request shape + `X-Engine-Secret` header (mocked transport).
- Voice `prepare` error mapping (`too_short` etc.).
- Modal apps: a `modal run` smoke test per engine (manual / CI-optional).

---

## 15. Build order (within the single release)

1. DB: `voices` + `genJobs` migrations.
2. `lib/ai/modal.ts` client + `lib/media/finalize.ts` shared helper (refactor video-job).
3. Modal `voice_engine.py` (prepare + tts) — deploy, benchmark TTS.
4. `/api/voices`, `/api/tts`, `/api/media/gen-job/[id]` + pricing actions + rate limits.
5. Voice Twin creator drawer + Voices manager UI.
6. Modal `avatar_engine.py` (pipeline) — deploy, **benchmark → finalize avatar pricing**.
7. `/api/media/generate-avatar` + Avatar tile/panel in the video studio.
8. Consent copy + terms clause + stub mode + tests.

---

## 16. Risks & open items

- **Avatar latency/cost**: minutes per clip + ~30–60 s cold start; real GPU spend.
  Mitigated by int8+distill, scale-to-zero, honest progress UI. Final price set by §10
  calibration.
- **Single vs. multi-GPU**: if 1×H100 can't hold the 1.5 model, fall back to 2×A100
  (higher cost) — resolved by benchmark in step 6.
- **In-browser recording** quality varies; we validate and surface a "too noisy" hint but
  cannot guarantee clone quality from a bad mic.
- **R2 creds in Modal**: scoped to a single bucket; rotate via Modal Secret if needed.
- **Model weights size / cold pulls**: cached in a Modal Volume to avoid re-download.
