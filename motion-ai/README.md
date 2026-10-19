# motion-ai worker

AI-designed motion graphics: Claude Code (headless, owner's subscription) writes a HyperFrames
composition from a post, the worker checks it, renders it to MP4 at 30 fps, grabs a poster and
uploads both to R2. Runs on the L40S box (`ssh l40ssociafy`), CPU only.

## Contract

Every request needs `X-Engine-Secret: <ENGINE_SECRET>`, otherwise `401 {"error":"bad_secret"}`.

### POST /motion-ai/submit → 202 `{callId}`

```json
{
  "prompt": "post text, <= 4000 chars",
  "aspect": "9:16 | 16:9 | 1:1",
  "durationSec": 12,
  "brand": {
    "brandName": "", "tagline": "", "cta": "",
    "colors": { "primary": "#..", "secondary": "#..", "background": "#..", "text": "#..", "accent": "#.." },
    "logoUrl": "https://…", "logoReverseUrl": "https://…", "fontDisplayUrl": "https://…", "fontBodyUrl": "https://…",
    "style": "soft | bold"
  },
  "audio": { "narration": false, "sfx": false, "music": false, "voice": "ElevenLabs voice id or name", "language": "en | hi | hi-IN …" },
  "footage": [ { "url": "https://…/clip.mp4", "label": "barista hands", "startSec": 0, "trimStartSec": 0, "durationSec": 5 } ],
  "videoKey": "users/<id>/….mp4",
  "posterKey": "users/<id>/….jpg"
}
```

`400 {error}` codes: `bad_json`, `bad_prompt`, `bad_aspect`, `bad_duration` (6–20 s), `bad_key`
(keys must start with `users/` and use only `[A-Za-z0-9._-/]`, no `..`). Brand URLs must be
`https://` (≤10 MB, 20 s timeout). Non-https, unreachable or unknown-type assets are skipped
rather than failing the job. Invalid colors are dropped.

`footage` is optional (hybrid video: AI/stock footage under brand type). Up to 5 clips; `url` must be
`https://`; `label` a string (≤ 80 chars kept); `startSec` (0 … duration − 0.5, where the clip starts
in the video), `trimStartSec` (0 … 600, offset into the source) and `durationSec` (0.5 … duration,
how much of the source to use) are optional numbers. Anything else → `400 {"error":"bad_footage"}`.
Before Claude runs, the worker downloads each clip (https only, also after redirects; response
`content-type: video/*`; ≤ 200 MB; 60 s), probes it with ffprobe and normalises it (trim, muted
H.264 yuv420p 30 fps, longest side ≤ 1920) into `assets/footage/fN.mp4`, then lists the clips in
`footage.json` (`id, file, label, durationSec, width, height, startSec?`) and BRIEF.md. Claude must
place every clip as a muted `<video>` (cover/crop, scrims behind text, brand-pure end card). Any
clip failing to download/probe/transcode fails the job with `footage_failed` (footage is never
dropped). Footage jobs get +5 min on the job timeout. Edits inherit the parent's footage (copied
from its project, not re-downloaded).

`audio` is optional; missing or non-boolean flags take the defaults shown (narration off, SFX on,
music off). `voice` (`[A-Za-z0-9 ._'-]`, ≤ 60) and `language` (`xx` or `xx-YY`) are dropped when
malformed; the default voice is Bella (`hpp4J3VqNfWAUOO0d1Us`), a name matches the start of an
ElevenLabs voice name.

Canvas: 9:16 → 1080×1920, 16:9 → 1920×1080, 1:1 → 1080×1080.

### GET /motion-ai/result?callId=… → 200

```json
{ "status": "pending" }
{ "status": "failed", "error": "footage_failed | claude_failed | check_failed | render_failed | timeout | upload_failed | parent_not_found | internal_error" }
{ "status": "done", "videoKey": "…", "posterKey": "…", "videoUrl": "<R2_PUBLIC_URL_BASE>/<videoKey>",
  "posterUrl": "<R2_PUBLIC_URL_BASE>/<posterKey>", "sizeBytes": 1234567,
  "segments": [ { "id": "s1", "label": "Hook", "startSec": 0, "endSec": 3.2,
                  "onScreenText": "…", "narration": "words spoken here (only when narrated)",
                  "suggestions": ["Make the headline punchier", "…"], "footage": true } ],
  "audio": { "narration": true, "sfx": true, "music": true } }
```

Unknown callId → `404 {"status":"failed","error":"not_found"}`.

`segments` is always present when done. It holds 3–6 contiguous segments from 0 to the duration,
written by Claude (`segments.json`) and validated by the worker. If the manifest is missing or
invalid, it's one segment covering the whole video with `suggestions: []`. `footage: true` is present
only on segments where footage is on screen (hybrid jobs).

`audio` says what the MP4 really carries (a kind counts only when its file is used by the final
composition and the render has audible sound). Audio never fails a job: if ElevenLabs is
unreachable or out of quota the video is delivered silent with
`{"narration":false,"sfx":false,"music":false,"warning":"audio_unavailable"}`; if only some of the
requested kinds made it, `"warning":"audio_partial"`. Jobs created before audio existed have no
requested audio and never warn.

Edit jobs also return `"parentCallId": "…"` when done.

### POST /motion-ai/edit → 202 `{callId}`

```json
{ "parentCallId": "<callId of a done job>", "segmentId": "s1", "instruction": "1–1000 chars",
  "videoKey": "users/<id>/….mp4", "posterKey": "users/<id>/….jpg" }
```

Revises a finished job. `segmentId` is optional: given, Claude changes only that segment's time
range; omitted, the instruction applies to the whole piece. Duration, canvas, brand and the other
segments stay unchanged unless the instruction says otherwise. Aspect, duration, brand and audio
settings carry over from the parent; the existing sounds are kept unless the instruction asks for
an audio change ("make the voice calmer", "remove the whoosh"), which the edit may make with any
audio kind. The parent can itself be an edit job (edits of edits). Poll with
`GET /motion-ai/result` like a normal job; same queue and concurrency.

`404 {"error":"parent_not_found"}`: unknown/malformed parentCallId, parent not `done`, or its
project already swept (30 days). `400 {error}`: `bad_json`, `bad_segment` (malformed or not in the
parent's segments), `bad_instruction` (empty or > 1000 chars), `bad_key`.

### GET /motion-ai/health → `{ok, queued, running}`

## Behaviour

- Audio: Claude generates sound with `motion-audio` (`motion-audio.mjs`, installed as
  `~/motionai/bin/motion-audio`): ElevenLabs TTS (`eleven_v4`) for narration, `sound-generation`
  for SFX, `music` for the bed, falling back to a looping `sound-generation` bed when the key's plan
  has no music API (402, the case on the current free key). Fresh jobs may only generate the kinds
  requested (`MOTION_AUDIO_KINDS`). Files land in `assets/audio/` with a `ledger.json` (kind, text,
  ElevenLabs cost). Claude places them as HyperFrames `<audio>` elements (narration ducks the bed via
  a `volume` automation lane, see `scaffold/CLAUDE.md`); the render mixes them, then the worker
  runs a two-pass `loudnorm` (−16 LUFS integrated, −1.5 dBTP), AAC 192k 48 kHz, trimmed to exactly
  the duration with the video stream copied. `ELEVENLABS_API_KEY` lives in `~/motionai/.env` and
  is passed as an env var into the Claude step's sandbox only (never written into the project).
- Concurrency 2, FIFO queue. Timeouts: Claude 12 min, check 2 min, render 5 min, whole job 22 min.
- Per job (`~/motionai/jobs/<callId>/`): scaffold `project/` (scaffold/ + BRIEF.md + downloaded
  brand assets), then `claude -p … --model opus --output-format json --max-turns 80 --allowedTools "Read,Write,Edit,Glob,Grep,Skill,Bash(npx hyperframes*),Bash(npm run *),Bash(ls*),Bash(motion-audio *)"`.
  Edit jobs instead copy the parent's `project/` (no renders), add `EDIT.md` (instruction + target
  segment) and run Claude with an edit task (same tools, sandbox and timeouts).
  Then the worker (not Claude) runs `hyperframes check`, `render`, ffmpeg poster, and the R2 upload.
  Poster frame = the first headline fully on screen: in the first segment with `onScreenText` (else the
  hook) at `max(start + 0.6 × (end − start), end − 0.4)`; without a valid segments.json, 35% in
  (`posterTimeSec` in lib.mjs). The end card is mostly blank at thumbnail size, so it is not the poster.
- Every job step runs in a `bwrap` sandbox: `/home` is hidden except the shared toolchain
  (read-only), the worker HOME (`~/motionai/home`: skills, fonts, npm cache) and the job dir. R2
  creds and `.env` are never visible to Claude or the renderer.
- State is `job.json` per job (atomic writes). On restart, pending jobs are re-run from scratch.
  Job dirs (project, claude.json, logs) are kept 30 days. MP4/poster files are deleted locally after upload.

## Layout

| file | what |
| --- | --- |
| `server.mjs` | node:http server, queue, job pipeline |
| `lib.mjs`, `lib.test.mjs` | input, footage, audio + segments validation (`node --test motion-ai/`) |
| `motion-audio.mjs` | the ElevenLabs audio CLI Claude may run inside the sandbox (tts / sfx / music / voices) |
| `scaffold/` | per-job project template (CLAUDE.md with the strict rules + design bar + snapshot self-review loop, index.html stub, local GSAP, grain.png, `reference/` helpers.js + example.html) |
| `motionai.service` | systemd **user** unit (`@BASE@` filled by install.sh) |
| `motionai-tunnel.service` | systemd user unit: reverse SSH tunnel to prod (see Box notes) |
| `install.sh` | idempotent box install: node 22, Chrome headless shell 152.0.7977.30, hyperframes@0.8.141, Noto fonts, claude binary copy, token copy, secret |
| `deploy.sh` | from the laptop: rsync code + HyperFrames skills (incl. media-use, hyperframes-audio), copy R2 vars from prod once, run install.sh |

Deploy: `bash motion-ai/deploy.sh`. Logs: `ssh l40ssociafy tail -f motionai/server.log`.
Status: `ssh l40ssociafy systemctl --user status motionai`.

## Box notes

`ubuntu` has no sudo, so there is no dedicated `motionai` user or system unit. The worker runs as
`ubuntu` under `systemd --user` (linger on) from `~/motionai`, isolated by bwrap. With root, create
the user and move BASE to `/srv/motionai` (install.sh takes `BASE=`).
The security group blocks inbound 8790, so this box dials out to prod instead:
`motionai-tunnel.service` (systemd user unit, installed by install.sh) holds
`ssh -R 127.0.0.1:8790:127.0.0.1:8790` to prod with the key `~/.ssh/motionai_tunnel`. On prod that
key is locked to that one forward in `~ubuntu/.ssh/authorized_keys`:

```
restrict,port-forwarding,permitlisten="127.0.0.1:8790",permitopen="127.0.0.1:8790",command="/bin/false" ssh-ed25519 AAAA… motionai-tunnel
```

(`permitopen` is needed because `port-forwarding` also re-enables `-L`; `permitopen="none"` is
rejected by sshd and disables the key.) Status: `ssh l40ssociafy systemctl --user status motionai-tunnel`.

App env: `MOTION_AI_URL=http://127.0.0.1:8790`, `MOTION_AI_SECRET` = `ENGINE_SECRET` in
`l40ssociafy:~/motionai/.env`.
