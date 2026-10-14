# Sociafy motion templates (v1)

Brand-parameterized HyperFrames (pinned `hyperframes@0.8.141`, GSAP 3.14.2 vendored) compositions, rendered at 30 fps.

| template   | length | what it does |
| ---------- | ------ | ------------ |
| `stat`     | 15 s   | hook, then 1–3 facts (numbers count up), optional kicker line, end card (logo, tagline, CTA) |
| `showcase` | 16 s   | hook, then 2–4 screenshots in framed cards with 2–3 word captions, end card |
| `sting`    | 7 s    | logo reveal, tagline, CTA |

```bash
node motion/render.mjs --template stat --aspect 9:16 --vars vars.json --out out.mp4
node motion/render.mjs --template sting --aspect 16:9 --vars vars.json --out out.mp4 --snapshot 1,3.5,6.5   # + PNGs in out-frames/
```
Flags: `--quality draft|standard|delivery` (default standard), `--fps` (default 30), `--keep` (keeps the staged project so you can debug it).
If `--out` doesn't end in `.mp4`, only the snapshots are written.

## Variables contract

Pass one JSON object (`--vars`). Every field is optional, and empty or invalid values use the fallbacks.

```jsonc
{
  "brandName": "IndusLabs",            // fallback "Your Brand"; used as the wordmark when there's no logo
  "tagline": "…",                      // fallback "Made for what's next"
  "cta": "Book a demo",                // fallback "Learn more"
  "colors": { "primary": "#5b5ef2", "secondary": "#a64fd9", "background": "#eef0f4", "text": "#15171b", "accent": "#f0607c" },
  "fontDisplayUrl": "", "fontBodyUrl": "",   // woff2 URL/path; empty → bundled Poppins / Inter
  "logoUrl": "", "logoReverseUrl": "",       // URL/path (svg/png); reverse is used on dark backgrounds
  "facts": ["3x faster replies"],      // ≤6 (stat uses the first 3; showcase uses them as fallback captions)
  "screenshots": ["https://…/a.png"],  // ≤8 (showcase uses the first 4); none → brand-coloured placeholder cards
  "musicMood": "none",                 // 'calm'|'upbeat'|'cinematic'|'none'; accepted but unused in v1 (no tracks shipped)
  "musicUrl": "",                      // optional audio file; mixed at 0.5 with a fade-in and a 1.5 s fade-out
  "style": "soft",                     // 'soft' | 'bold' (bold = dark, high contrast, heavier type, squarer corners)
  "hook": "Your customers call. *Riya* answers.",
  "lines": ["Every call, in *their* language"]
}
```

- **Arrays and nested objects aren't flattened.** HyperFrames passes `--variables` objects and arrays through to `getVariables()` as they are. Only the scalar fields are declared in `data-composition-variables` (for Studio), so **don't use `--strict-variables`**. `render.mjs` also bakes the values into the page as `window.__MOTION_VARS`, because `hyperframes snapshot` has no `--variables` flag.
- **Copy slots:** wrap a word in `*…*` to highlight it in hook, lines or captions. If a caption has no marker, its last word is highlighted.
  - `stat`: `lines[0]` is an optional kicker shown before the end card.
  - `showcase`: `lines[i]` is the caption for screenshot `i` (falls back to `facts[i]`).
- **Facts:** a fact that starts with a number token (`40%`, `$2.4M`, `10,000+`, `3x`) shows big and counts up. Any other fact shows as a statement.
- **Colours:**
  - Text falls back to ink or white if it fails 4.5:1 contrast against the background.
  - The highlight colour is the first of primary/accent/secondary that reaches at least 3:1.
  - The CTA text colour is picked automatically for contrast against the CTA.
  - A colour logo on a dark background with no reverse logo is placed on a white tile.
- **Text fitting:** all text auto-shrinks to its box. A long CTA (over about 45 characters) ends up in a small font and may be truncated with an ellipsis.
- **URLs:** `render.mjs` copies local paths and downloads http(s) URLs into the staged project, so the render itself makes no network calls. An asset that fails to download falls back to the default (the render does not fail).

## Layout

- `templates/<name>/index.html` is the composition, authored at 9:16. `render.mjs` rewrites the canvas to 1920×1080 for `--aspect 16:9`, and the layout adapts at runtime.
- `templates/_shared/` holds `kit.js` (fallbacks, theming, fitting, chip and end card), `kit.css` and `gsap.min.js`. These files and `fonts/` are symlinked into each template, and `render.mjs` stages a dereferenced copy in a temp dir.
- To check or preview a template on its own: `cd motion/templates/stat && npx hyperframes@0.8.141 check` (or `preview`). This runs with defaults only.
- `fonts/` contains Poppins 500/600/700 and Inter 400/500/600 (Latin subsets), both under the SIL OFL 1.1. See `OFL-poppins.txt` and `OFL-inter.txt`.
- `samples/` holds example vars: IndusLabs, fallback `{}`, and a bold/long-text stress test.

## Runtime deps (server / Modal)

- Node ≥ 22 (tested on 26.3).
- `npx` access to `hyperframes@0.8.141`. Bake it into the image instead of relying on `npx --yes` at runtime.
- Chrome headless shell, which hyperframes downloads to `~/.cache/hyperframes/chrome` on first run.
- `ffmpeg` + `ffprobe`.
- Each render worker uses about 256 MB RAM.

On Linux without a GPU, hyperframes falls back to screenshot capture with software GL, which is expected to be several times slower than the Mac times measured below.

## Measured on an M5 Mac (hardware GPU, standard quality)

| template | 9:16 | 16:9 |
| -------- | ---- | ---- |
| stat 15 s | 10.0 s | 10.5 s |
| showcase 16 s (4 shots) | 14.7 s | 12.2 s |
| sting 7 s | 6.8 s | 7.1 s |

## Known limitations (v1)

- No music ships with the templates. `musicMood` is accepted but ignored; pass `musicUrl` for audio.
- Durations are fixed per template (HyperFrames can't vary the root duration through variables).
- Custom fonts load as one face for all weights. Fonts not in the bundled Latin subsets (e.g. ₹, Devanagari) fall back to system fonts.
- `stat` shows at most 3 facts and `showcase` at most 4 screenshots. Very tall screenshots are cropped from the top.
