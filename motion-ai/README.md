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
  "videoKey": "users/<id>/….mp4",
  "posterKey": "users/<id>/….jpg"
}
```

`400 {error}` codes: `bad_json`, `bad_prompt`, `bad_aspect`, `bad_duration` (6–20 s), `bad_key`
(keys must start with `users/` and use only `[A-Za-z0-9._-/]`, no `..`). Brand URLs must be
`https://` (≤10 MB, 20 s timeout). Non-https, unreachable or unknown-type assets are skipped
rather than failing the job. Invalid colors are dropped.

Canvas: 9:16 → 1080×1920, 16:9 → 1920×1080, 1:1 → 1080×1080.

### GET /motion-ai/result?callId=… → 200

```json
{ "status": "pending" }
{ "status": "failed", "error": "claude_failed | check_failed | render_failed | timeout | upload_failed | parent_not_found | internal_error" }
{ "status": "done", "videoKey": "…", "posterKey": "…", "videoUrl": "<R2_PUBLIC_URL_BASE>/<videoKey>",
  "posterUrl": "<R2_PUBLIC_URL_BASE>/<posterKey>", "sizeBytes": 1234567,
  "segments": [ { "id": "s1", "label": "Hook", "startSec": 0, "endSec": 3.2,
                  "onScreenText": "…", "suggestions": ["Make the headline punchier", "…"] } ] }
```

Unknown callId → `404 {"status":"failed","error":"not_found"}`.

`segments` is always present when done. It holds 3–6 contiguous segments from 0 to the duration,
written by Claude (`segments.json`) and validated by the worker. If the manifest is missing or
invalid, it's one segment covering the whole video with `suggestions: []`.

Edit jobs also return `"parentCallId": "…"` when done.

### POST /motion-ai/edit → 202 `{callId}`

```json
{ "parentCallId": "<callId of a done job>", "segmentId": "s1", "instruction": "1–1000 chars",
  "videoKey": "users/<id>/….mp4", "posterKey": "users/<id>/….jpg" }
```

Revises a finished job. `segmentId` is optional: given, Claude changes only that segment's time
range; omitted, the instruction applies to the whole piece. Duration, canvas, brand and the other
segments stay unchanged unless the instruction says otherwise. Aspect, duration and brand carry
over from the parent. The parent can itself be an edit job (edits of edits). Poll with
`GET /motion-ai/result` like a normal job; same queue and concurrency.

`404 {"error":"parent_not_found"}`: unknown/malformed parentCallId, parent not `done`, or its
project already swept (30 days). `400 {error}`: `bad_json`, `bad_segment` (malformed or not in the
parent's segments), `bad_instruction` (empty or > 1000 chars), `bad_key`.

### GET /motion-ai/health → `{ok, queued, running}`

## Behaviour

- Concurrency 2, FIFO queue. Timeouts: Claude 8 min, check 2 min, render 5 min, whole job 15 min.
- Per job (`~/motionai/jobs/<callId>/`): scaffold `project/` (scaffold/ + BRIEF.md + downloaded
  brand assets), then `claude -p … --output-format json --max-turns 60 --allowedTools "Read,Write,Edit,Glob,Grep,Skill,Bash(npx hyperframes*),Bash(npm run *),Bash(ls*)"`.
  Edit jobs instead copy the parent's `project/` (no renders), add `EDIT.md` (instruction + target
  segment) and run Claude with an edit task (same tools, sandbox and timeouts).
  Then the worker (not Claude) runs `hyperframes check`, `render`, ffmpeg poster (0.8 s before the end), and the R2 upload.
- Every job step runs in a `bwrap` sandbox: `/home` is hidden except the shared toolchain
  (read-only), the worker HOME (`~/motionai/home`: skills, fonts, npm cache) and the job dir. R2
  creds and `.env` are never visible to Claude or the renderer.
- State is `job.json` per job (atomic writes). On restart, pending jobs are re-run from scratch.
  Job dirs (project, claude.json, logs) are kept 30 days. MP4/poster files are deleted locally after upload.

## Layout

| file | what |
| --- | --- |
| `server.mjs` | node:http server, queue, job pipeline |
| `lib.mjs`, `lib.test.mjs` | input + segments validation (`node --test motion-ai/`) |
| `scaffold/` | per-job project template (CLAUDE.md with the strict rules, index.html stub, local GSAP) |
| `motionai.service` | systemd **user** unit (`@BASE@` filled by install.sh) |
| `motionai-tunnel.service` | systemd user unit: reverse SSH tunnel to prod (see Box notes) |
| `install.sh` | idempotent box install: node 22, Chrome headless shell 152.0.7977.30, hyperframes@0.8.141, Noto fonts, claude binary copy, token copy, secret |
| `deploy.sh` | from the laptop: rsync code + HyperFrames skills, copy R2 vars from prod once, run install.sh |

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
