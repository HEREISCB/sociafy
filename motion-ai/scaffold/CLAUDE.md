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
  "Noto Sans Display", sans-serif. No other images unless you draw them in SVG/CSS.
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

## How

1. Read `BRIEF.md`.
2. Read these skill references (Read tool, they are local) and follow their contract:
   - `~/.claude/skills/hyperframes-core/SKILL.md` (composition contract, determinism)
   - `~/.claude/skills/motion-graphics/categories/kinetic-type/module.md` and
     `~/.claude/skills/motion-graphics/references/motion-vocabulary.md` (if present)
   - `~/.claude/skills/hyperframes-animation/SKILL.md` and only the 2–4 rules you actually use.
   Skip the skills' interactive steps: no subagents, no `hyperframes init`, no preview, no
   render, no media sourcing, no approval questions. Work fast; you have a few minutes.
3. Write `index.html`.
4. Run `npx hyperframes@0.8.141 check` and fix **every error** until it passes. Re-run after each fix.
   Do not run `render`; the worker renders after you exit.
5. Write `segments.json`, then reply with one line: what you made.
