# Headless motion-graphic job (non-interactive)

You are running unattended inside a render worker. There is **no human to ask**: never ask
questions, never wait for approval, never open a preview. Make every decision yourself.

## Deliverable

One HyperFrames composition in **this folder's `index.html`** (edit the stub in place) that is a
short, design-led **kinetic-typography / brand motion graphic** of the post in `BRIEF.md`,
plus a `segments.json` manifest (see below).

Hard requirements (the worker rejects the job otherwise):

- Canvas exactly **{{W}}×{{H}}**: root `data-width="{{W}}" data-height="{{H}}"`.
- Duration exactly **{{DUR}} s**: root `data-duration="{{DUR}}"`; no clip ends past it. 30 fps.
- Root `data-composition-id="main"`, one paused GSAP timeline registered at
  `window.__timelines["main"]`. Deterministic: no `Date.now()`, no unseeded `Math.random()`,
  no fetches, no timers.
- **No network at render time.** No CDN `<script>`/`<link>`/`@import`/remote `url()`. GSAP is at
  `assets/gsap.min.js` (already wired in the stub). Brand logo/fonts, if provided, are already in
  `assets/` (listed in `BRIEF.md`). Otherwise use system fonts: "Noto Sans", "Noto Serif",
  "Noto Sans Display", sans-serif. No other images unless you draw them in SVG/CSS. Exception:
  footage clips listed in `BRIEF.md` → Footage (already in `assets/footage/`), see below.
- Use the brand colors from `BRIEF.md`. Text must be legible (strong contrast), never cut off,
  never overlapping. Keep important text inside the safe area given in `BRIEF.md`.
- Final beat: a brand end card (logo if provided, else brand name; tagline/CTA if provided)
  fully settled and **held still for at least the last 1.5 s**. The poster is taken 0.8 s before the end.
- Don't paste the whole post on screen. Distill it into 3–5 short, punchy on-screen lines
  (hook → key point(s) → payoff → end card). Big type, strong hierarchy, purposeful motion.
- Only create/edit files inside this folder. Do not touch `node_modules`, `package.json` or `hyperframes.json`.

## segments.json (required)

Before finishing, write `segments.json` in this folder describing your timeline:

```json
{"segments":[{"id":"s1","label":"Hook","startSec":0,"endSec":3.2,"onScreenText":"…","suggestions":["Make the headline punchier","Slow the reveal"]}]}
```

3–6 contiguous segments in order: the first starts at 0, each `startSec` equals the previous
`endSec`, the last ends at exactly {{DUR}}. `onScreenText` is the text visible in that segment.
`suggestions` holds 2–3 short, concrete edits a user could click to improve that segment.
When narration is on, add `"narration": "…"` to each segment with the exact words spoken in it.

## Footage (only when `BRIEF.md` has a Footage section)

A hybrid video: real footage underneath, crisp brand type/overlays on top. **Every listed clip
must be on screen** (the user paid for footage); the end card stays brand-exact on brand colors.

- Place each clip as a muted, framework-owned `<video>` (no `play()`/seek code, no `crossorigin`):
  ```html
  <div class="footage-wrap" id="fw1" style="position:absolute;inset:0;overflow:hidden">
    <video id="f1" class="clip" src="assets/footage/f1.mp4" muted playsinline
      data-start="0" data-duration="5" data-track-index="0"
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  </div>
  ```
  Timing goes on the `<video>` only (never `data-start` on an ancestor too). Its `data-duration`
  must not exceed the clip's duration in BRIEF.md. A clip with a given start must begin exactly
  there; sequence the rest in manifest order. Full-bleed (`object-fit: cover`, crop, never stretch
  or distort the aspect) or framed (a card/phone/window shape; still `cover` inside it): your call.
- Fill the remaining time with your own motion design (brand background, type); total stays
  exactly {{DUR}} s. Footage usually leads (hook/proof); the end card is pure brand, no footage.
- Motion over footage stays slow and subtle (gentle push-in 1.00→1.06 on the wrapper, soft fades,
  short slides); the footage already moves. Animate the wrapper or overlays, never the
  `<video>`'s size, and never `autoAlpha`/`visibility` on a `.clip`.
- Legibility (mandatory): text never sits directly on footage. Every overlay text over footage
  needs ALL of:
  1. **Scrim**: a gradient from ~70 % to 0 % of the darkest brand-safe color (or `#000`) covering
     the text region plus margin (e.g. `linear-gradient(to top, rgba(0,0,0,.7), transparent)`
     sized to the text block + ~120 px), or, for short stat/CTA text, a solid rounded text plate in
     a brand color. The scrim is visible for the whole time the text is (fade it with the text).
     Light text on dark scrim or dark text on light plate, contrast ≥ 4.5:1.
  2. **Opaque hold**: text is fully opaque (opacity 1) for its whole hold time. Fade only at entry
     and exit, each ≤ 0.3 s; never mid-hold, never a slow cross-fade over bright detail.
  3. **Calm footage under text**: optionally darken the footage wrapper 8–15 % or add a slight
     blur (≈ 2–4 px) while text is on screen (animate the wrapper, not the `<video>`).
  4. **Placement**: never put text over the footage's own busiest region; prefer the lower third /
     safe zones. On 9:16 keep all text clear of the top 220 px and bottom 380 px of 1920 (platform
     UI); headline in the upper-middle or the lower third above the bottom 380 px.
- In `segments.json`, add `"footage": true` to every segment where footage is on screen.

## Audio (only the kinds `BRIEF.md` → Audio turns on)

Generate sound only with `motion-audio` (ElevenLabs). Each call prints one JSON line:
`{"ok":true,"file":"assets/audio/<id>.mp3","durationSec":1.9}` or `{"ok":false,"error":…}`.
On `ok:false` leave that sound out and carry on (if the first call fails with
`audio_unavailable`, skip all audio): the video must work silent. Never reference a file that
wasn't written. Every call spends credits: no test calls, at most 2 regenerations per job.

- **Narration**: one short line per segment (skip the end card or keep it to the brand name),
  in the BRIEF's language, written for the ear, ≤ 2.3 words per second of segment time.
  `motion-audio tts n1 "Three days. Gone." --voice "<voice>" --lang <lang>` (omit flags BRIEF leaves
  empty). If `durationSec` doesn't fit its segment with 0.3 s spare, shorten the words and
  regenerate (or `--speed 1.1`). Start each line ~0.2 s into its segment; all narration ends
  ≥ 0.8 s before {{DUR}}. Time the on-screen beats to the voice.
- **SFX**: 2–4 subtle hits on real visual beats (transition whoosh, headline impact, end-card
  chime): `motion-audio sfx w1 "soft airy whoosh" --dur 0.8` (0.5–3 s).
- **Music**: one bed: `motion-audio music bed "<mood>, <tempo>, minimal" --dur {{DUR}}`.

Place them as HyperFrames `<audio>` elements (every one needs a unique `id`, no `crossorigin`),
at the end of `#root`, never inside a `.clip`. `data-start`/`data-duration` in seconds; the
duration must not exceed the file's `durationSec` or run past {{DUR}}:

```html
<audio id="vo-n1" src="assets/audio/n1.mp3" data-start="0.2" data-duration="2.1" data-track-index="20" data-volume="1" data-audio-group="voiceover"></audio>
<audio id="sfx-w1" src="assets/audio/w1.mp3" data-start="3.1" data-duration="0.8" data-track-index="21" data-volume="0.35"></audio>
<audio id="music" src="assets/audio/bed.mp3" data-start="0" data-duration="{{DUR}}" data-track-index="23" data-volume="1"
  data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":0},{"t":0.5,"v":0.4},{"t":0.6,"v":0.12},{"t":2.4,"v":0.12},{"t":2.7,"v":0.4},{"t":11,"v":0.4},{"t":12,"v":0}]}]}'></audio>
```

Mix: narration at 1.0; SFX 0.25–0.5 (≤ 0.3 while a voice line plays; overlapping SFX go on track
22); the bed fades in over ~0.5 s and out over the last ~1 s, sits at ~0.4 and **ducks to ~0.12
during every narration line** (0.15–0.3 s ramps) via its `volume` lane (`t` is seconds from the
bed's start). No GSAP tweens on audio. The worker normalises loudness and trims to {{DUR}}.
Mixing reference if needed: `~/.claude/skills/hyperframes-audio/references/attributes.md`.

## How

1. Read `BRIEF.md`.
2. Read these skill references (Read tool, they are local) and follow their contract:
   - `~/.claude/skills/hyperframes-core/SKILL.md` (composition contract, determinism)
   - `~/.claude/skills/motion-graphics/categories/kinetic-type/module.md` and
     `~/.claude/skills/motion-graphics/references/motion-vocabulary.md` (if present)
   - `~/.claude/skills/hyperframes-animation/SKILL.md` and only the 2–4 rules you actually use.
   Skip the skills' interactive steps: no subagents, no `hyperframes init`, no preview, no
   render, no media sourcing other than `motion-audio`, no approval questions. Work fast; you have a few minutes.
3. Write `index.html`.
4. Run `npx hyperframes@0.8.141 check` and fix **every error** until it passes. Re-run after each fix.
   Do not run `render`; the worker renders after you exit.
   (Audio first if enabled: generate it right after reading BRIEF.md so the timing can follow the voice.)
5. Write `segments.json`, then reply with one line: what you made.
