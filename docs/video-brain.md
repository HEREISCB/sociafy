# Video brain: AI video vs motion graphic vs hybrid

How Sociafy should choose, for each post, between AI video, a motion graphic, or a hybrid (AI footage
composited inside a motion graphic, with text and brand overlays rendered as real type).
Vendor names appear in this doc only. Product UI and API use the public names.
Researched 2026-10-17. Evidence: vendor docs, a few reviews (marked "review"), our code, and our own renders.

## 0. Ground truth from our own stack

| fact | source |
|---|---|
| Motion 1 envelope: 4–15 s, 480/720/1080p, 9:16, 1:1, 16:9, modes text / reference / image-to-video, silent | `lib/ai/models.ts` |
| Cinema 1 envelope: 4–30 s, 480/720p only (max 0.98 MP, 1344×768), modes text / image-to-video (refs withheld), native audio, end frame alone allowed | `lib/ai/models.ts` |
| Cinema render time at 720p: **4 s → 134 s, 8 s → 345 s, 15 s → 965 s, 30 s → 3046 s (~51 min)** | `~/code/MinimaxH3-test/HANDOFF-SOCIAFY-ASYNC.md` |
| H3 "cannot write words": a masthead-sized word may survive, body copy never does. Text plates hold only in the first frame and drift later | `~/.claude/skills/h3-video/SKILL.md` |
| Cinema prompt rewriter bans screens, feeds, chat bubbles and small print ("got mush"). One large quoted line per shot at most | `MinimaxH3-test/HANDOFF.md` §enhance |
| Cinema screening: always blocks sexual/minors, threats, violent wrongdoing, self-harm instructions. Everything else is open, violence included | `MinimaxH3-test/HANDOFF.md` §5 |
| Templates: stat (15 s), showcase (16 s), sting (7 s). **9:16 and 16:9 only**, fixed lengths, ≤3 facts, ≤4 screenshots, numbers count up, contrast is auto-checked. Fonts outside Latin (₹, Devanagari) fall back to system fonts | `motion/README.md` |
| AI motion graphic: 6–20 s, 9:16 / 16:9 / 1:1, brand colors, logo and fonts, 3–6 editable segments, optional ElevenLabs narration, SFX and music. Falls back to silent, never fails on audio. **No raster images except the brand logo** (SVG/CSS only) | `motion-ai/README.md`, `motion-ai/scaffold/CLAUDE.md` |
| Our AI motion renders (`/tmp/motionai-test/*.mp4`, `/tmp/sociafy-live/v9.mp4`): 1080×1920, type pixel-perfect, brand colors exact, logo exact. Narrated render: mean −18.8 dB, peak −1.4 dB. `audio-fail.mp4` came out silent with no audio stream, as designed. **Visual weakness:** every frame is flat background, soft blobs and type, so it reads like a slide in a feed. This is the gap a hybrid fills | ffprobe and frame strips |
| Our H3 render (`MinimaxH3-test/final.mp4`): 1344×768, 5.17 s, audio stream present. Photoreal fur, light and motion are convincing | ffprobe and frame strip |

## 1. Engine pros and cons

| engine (public name) | best at | weak at / failure modes | limits | cost (cr) | time |
|---|---|---|---|---|---|
| **Seedance 2.5** (Motion 1, quality) | Photoreal scenes, camera moves (review: camera control 4.67/5, temporal consistency 4.55), product shots from stills (first and last frame, up to 9 omni references), 1080p, character consistency | **Text and numbers garble** (diffusion). Review: "human motion reads slightly stiff", secondary objects freeze, it "reinterprets explicit shot lists". Faces get soft at 720p in a push-in. Brand hex colors are approximate. Logos are not reproducible. Rerolls are expensive | 4–15 s in our envelope (vendor allows 4–30). Silent in our use | **39 cr/s** at 720p (vendor $0.35/s). 1080p ≈ 2.3× (vendor $0.80/s) | 1–3 min. Vendor warns of peak queues |
| **Seedance 2.0 Fast** (Motion 1, fast) | Same strengths at lower fidelity. Cheap b-roll | No 1080p. More artifacts: fingers warp, crowds and complex motion break (review). Same text and logo failures | 4–15 s, 480/720p | **18 cr/s** at 720p (vendor $0.096/s, marked "limited-time promotion", so the price may rise) | ~1–2 min. Vendor warns of multi-hour queues 09:00–15:00 GMT |
| **H3 self-hosted** (Cinema 1) | **Sound on**: dialogue, SFX and score in one pass. Emotional, cinematic mood. Longest clips (to 30 s). Can end on a supplied frame. Takes its shape from the frame. Strong photoreal texture | Cannot write words. Screens and UI turn to mush. Max 0.98 MP. Reference images withheld, so no multi-reference product or person identity. Each clip scores its own music, so stitched clips do not match. Real-person identity drifts on edit (`HANDOFF.md`) | 4–30 s, 480/720p | **Live quote**, ~25 cr for 8 s at 720p. By far the cheapest per second | **Slow**: 8 s ≈ 6 min, 15 s ≈ 16 min, 30 s ≈ 51 min |
| **Motion templates** (Motion Graphics) | Deterministic. Exact brand. Counters, stats, screenshots in framed cards, logo sting. Contrast-safe | Looks the same every time. Fixed lengths. No 1:1. No music shipped. Non-Latin glyphs fall back | stat 15 s, showcase 16 s, sting 7 s. 9:16 and 16:9 only | 18 cr/s (stat 270, showcase 288, sting 126) | ~10–15 s on M5 GPU. Slower on CPU boxes |
| **AI motion graphic** (Claude writes HyperFrames) | Kinetic typography, quotes, opinions, lists, exact brand, any language the fonts cover, narration in the post's language, **edit one segment at a time** | Image-poor: no photos, footage or screenshots today, so it can look like a deck. Layout varies run to run (it is an LLM). Claude step can fail (`claude_failed` / `check_failed`) | 6–20 s. 9:16, 16:9, 1:1 | 18 cr/s, +4 cr/s with narration or music. Edits 9 cr/s | 1.5–2.5 min |

Sources: [PiAPI Seedance 2.5 docs](https://piapi.ai/docs/seedance-api/seedance-25), [PiAPI Seedance 2 / Fast docs](https://piapi.ai/docs/seedance-api/seedance-2), [ByteDance Seedance 2.0](https://seed.bytedance.com/en/seedance2_0), [Kittl 2.5 review (scores)](https://www.kittl.com/blogs/?p=26160), [Segmind 2.5 use-case test](https://blog.segmind.com/seedance-2-5-review-five-real-world-use-cases-and-exactly-what-each-one-costs/), [whyops 2.0 review](https://whyops.com/blog/seedance-2-0-review-hype-reality), [Seedance real-face rules](https://aividpipeline.com/blog/seedance-real-human-face-rules-2026), [MindStudio on Seedance restrictions](https://www.mindstudio.ai/blog/seedance-2-0-content-restrictions-workarounds).

**Content policy (AI video).** Seedance moderates every request and refunds rejections. Strict models
retry on a second review path (PiAPI). Reviews consistently report that **realistic real-person
face references are often rejected**, and that named celebrities and politicians are blocked. One
Segmind request was refused "on copyright grounds" with an ordinary prompt. Cinema blocks
anything sexual involving minors outright and screens with omni-moderation. Rule for the brain:
never ask AI video to depict an identifiable real person, a celebrity, a minor, or another
company's brand or logo. Graphics engines have no policy gate beyond our own post screening.

## 2. Post signals → format rules

Signals the brain extracts. All are cheap to compute from the post text, attachments, brand kit and
target platforms.

| # | signal (how to detect) | pushes toward | rule |
|---|---|---|---|
| S1 | **Must-show text**: numbers, %, ₹/$, dates, prices, URLs, product names, a CTA, a quote. Count the words that must be legible | graphics | Any number, price or date, or more than 3 must-show words: **the text layer is graphics. Never rely on AI video for it** (H3 skill: "cannot write words"). AI video may still supply the footage behind it |
| S2 | **Stats / data / comparison** ("3x", "from 3 days to 20 min", "40%") | motion graphic | ≤3 facts → `stat` template, or AI motion for a custom layout. >3 facts or a before/after → AI motion |
| S3 | **List / steps / tips / thread** ("5 ways…", numbered lines) | AI motion (kinetic) | One beat per item, max 5 beats in 20 s, otherwise split into a carousel |
| S4 | **Quote / opinion / hot take / founder POV**, no physical nouns | AI motion (kinetic) | Big-type hook, then payoff, then end card |
| S5 | **Physical scene or action** (concrete subject + verb + place: "chef plating in a busy kitchen", "runner at dawn") | AI video | Footage carries it. Add a brand end card (hybrid-lite) when a brand kit exists |
| S6 | **Product photo attached** | image-to-video, or showcase | Hero shot of a physical product → Motion 1 (2.5) image-to-video with the photo as first frame (keeps the label and shape) plus graphic overlays. Several photos plus specs → `showcase` template |
| S7 | **UI screenshots attached / SaaS feature** | showcase template | Never AI video for UI. Screens turn to mush (`HANDOFF.md`) |
| S8 | **Announcement / launch / event** (verbs: launching, introducing, now live; a date or offer) | hybrid if S5, otherwise motion graphic | The offer, date and CTA must be type. A scene, if described, becomes footage |
| S9 | **Abstract concept** (trust, growth, AI, productivity) | AI motion. Hybrid only if a concrete metaphor is named | Don't spend AI video on vague "futuristic AI" b-roll. It is generic and costly |
| S10 | **Mood / story / emotional / cinematic** ("feels like", nostalgia, a customer story) | AI video (Cinema if sound matters) | Cinema when native sound or score is the point and latency is acceptable |
| S11 | **Identifiable real person, celebrity, minor, competitor brand** | graphics | Policy gate: no AI video of them. Use a still in a graphic (showcase) or faceless footage (hands, back view, wide shot) |
| S12 | **Platform** | LinkedIn/X → graphics. Reels/TikTok/Shorts → footage | LinkedIn B2B: text-led, 1:1 or 16:9 (or 9:16 mobile), assume muted autoplay, SFX only. Reels/TikTok/Shorts: 9:16, footage hook in the first 1–2 s, sound on (music bed or Cinema audio) |
| S13 | **Brand kit strictness** (strict colors, logo present, `brandSafetyStrict`) | graphics or hybrid | AI video colors are approximate. Brand must-haves go in the overlay layer |
| S14 | **Language not Latin**: a letter from a non-Latin script. Currency symbols (₹), digits, punctuation and emoji don't count | AI motion | Templates fall back to system fonts for these (and for ₹, which keeps a post off templates without being S14). AI motion uses Noto. AI video cannot write any script |
| S15 | **Explainer / how-to longer than 12 s** | AI motion + narration | Narration ≤2.3 words/s (scaffold rule). Skip narration for LinkedIn-only posts |

## 3. Hybrid recipes

Hybrid = AI footage played as a `<video>` clip inside the HyperFrames composition, with type, logo
and CTA as real DOM layers on top. The composited output is always 1080p, so 720p footage is
enough wherever overlays or a scrim cover it.

| recipe | layout (12 s example) | footage share | footage engine | use when |
|---|---|---|---|---|
| **H1 Scene sandwich** | 0–2 s kinetic hook → 2–8 s footage with a 3–6-word caption bar → 8–12 s end card | 50% (6 s) | **Fast** 720p (108 cr) | Announcement plus a scene (S8 + S5) |
| **H2 Stat over b-roll** | footage full-bleed 0–9 s under a 35–45% brand-color scrim, numbers count up on top → 3 s end card | 75% (9 s) | **Fast** (scrim hides artifacts) | Stats with a physical context ("we cut delivery time 40%" over a courier) |
| **H3 Product hero** | 0–5 s image-to-video from the product photo (slow push or orbit) → 5–9 s spec chips / price over a held last frame → 3 s CTA | 40–55% | **2.5** 720p, or 1080p if the hero is unobscured (fidelity to the photo matters) | S6 with a price or offer |
| **H4 Framed footage** | footage inside a rounded card or device frame (~60% of canvas) while big type animates beside or above it | 60–80% | **Fast** | LinkedIn 1:1 / 16:9, B2B case studies |
| **H5 Cinematic opener** | 0–6 s Cinema clip **with its own audio as the bed** → 6–10 s kinetic payoff → end card. Motion-ai music off, SFX ≤0.3 | 50–60% | **Cinema** (cheapest, ~6 min for 6–8 s) | Mood or story posts on Reels/TikTok, scheduled ≥30 min out |
| **H6 Brand end card (hybrid-lite)** | pure AI video plus a 2–3 s sting-style end card | 80–85% | any | Default wrapper for every AI-video choice when a brand kit exists |

Rules: footage clips are 4–8 s (Seedance minimum is 4 s; shorter footage segments are trimmed from a 4 s
render). One footage clip per hybrid in v1. Keep all must-show text out of the footage prompt
(say "no text, no signage, no logos" in the prompt). Overlay text sits in the scaffold safe area.

## 4. Decision procedure (one LLM call, JSON out)

Planner: Groq `openai/gpt-oss-120b` (reasoning low), falling back to gpt-5-mini (reasoning minimal), then
the regex heuristic. Measured 2026-10-17 from the prod box, 3 posts, LLM call only: gpt-5-mini low p50
7.3 s (old), gpt-5-mini minimal p50 3.1 s, gpt-oss-120b p50 0.9 s. The balance/brand lookup runs in
parallel; drafts are cached 10 min per user + post, so re-plans (overrides, alternatives) cost only the
lookup (~0.35 s).

Inputs: post text, attachments (type and count, `has_person_photo`), brand kit (colors, logo,
`brandSafetyStrict`), target platforms, user credit balance, `deadline` (publish time minus now),
and user overrides.

```
1. OVERRIDES: if the user picked a format or engine, honor it; only validate the envelope and cost.
2. ASPECT: primary platform → 9:16 (Reels/TikTok/Shorts/Stories), 1:1 (LinkedIn/X feed default), 16:9 (YouTube/LinkedIn wide).
   1:1 rules out templates (use AI motion).
3. POLICY GATE (S11): real identifiable person / celebrity / minor / third-party brand → videoAllowed=false.
4. Score textNeed (S1–S4, S7, S13, S14) and sceneNeed (S5, S6-hero, S10) each as low|high.
     textNeed low,  sceneNeed low  → motion_graphic (AI motion, kinetic)
     textNeed high, sceneNeed low  → motion_graphic (template if it fits stat/showcase, else AI motion)
     textNeed low,  sceneNeed high → ai_video (+H6 end card if brand kit)
     textNeed high, sceneNeed high → hybrid (pick H1–H5)
   If videoAllowed=false, sceneNeed is forced to low.
5. FOOTAGE ENGINE (ai_video or hybrid):
     Cinema  if sound/mood is central OR duration > 15 s, AND deadline ≥ 3 × the render time in §0 (8 s → 20 min), AND no reference images are needed.
     2.5     if footage is the unobscured hero (product image-to-video, close faces, 1080p asked) or refs are needed.
     Fast    otherwise (default for b-roll under overlays).
6. DURATION: LinkedIn 8–12 s, Reels/TikTok 10–15 s, sting 7 s. Hybrid footage 4–8 s.
7. AUDIO: Reels/TikTok → music on (or Cinema audio). Narration only for explainers (S15) and never LinkedIn-only.
   LinkedIn → SFX only.
8. COST: estimate credits (footage s × engine rate + total s × 18 + audio s × 4; Cinema by live quote).
   ceiling = min(balance, max(0.25 × balance, cheapest viable option), user per-post cap if set).
   Above the ceiling → downgrade in order: 1080p→720p, 2.5→Fast, Fast→Cinema (if the deadline allows),
   shorten to the platform minimum, hybrid→motion_graphic, AI motion→sting template (126 cr).
   Only when the balance covers the cheapest viable option (the bottom of this ladder). If even that is
   > balance, skip the ladder: return the best-fit plan unchanged and priced, with `affordable: false` and
   `cheapest: {format, estimatedCredits, summary}`. The UI shows it with Generate disabled + Top up;
   generate-auto refuses it (402 insufficient_credits) before any charge. `none` is only for genuine
   impossibility (no engine this account can use), never for a low balance.
9. TIE-BREAKS (in order): legible text > brand fidelity > policy safety > cost > latency > visual novelty.
   LinkedIn breaks ties toward graphics; Reels/TikTok/Shorts toward footage.
10. SAFE DEFAULT (confidence < 0.6 or a parse failure): motion_graphic via AI motion, 12 s,
    platform aspect, SFX on, narration and music off (216 cr). It is deterministic in brand, cannot be refused, edits per segment, and renders in about 2 min.
```

Output schema:
```json
{ "format": "ai_video|motion_graphic|hybrid|none", "recipe": "H1..H6|null",
  "graphics": {"engine": "ai_motion|template", "template": "stat|showcase|sting|null"},
  "footage": {"engine": "seedance-2.5|seedance-2-fast|cinema|null", "mode": "text|image-to-video|reference",
              "seconds": 6, "quality": "720p", "prompt": "… no text, no logos …"},
  "durationSec": 12, "aspect": "9:16", "audio": {"narration": false, "music": true, "sfx": true},
  "onScreenText": ["…"], "estimatedCredits": 330, "confidence": 0.8,
  "signals": ["S1","S8"], "reasons": ["…"], "fallback": {"format": "motion_graphic", "estimatedCredits": 216} }
```
The `fallback` field is what runs if the AI video job is refused or fails. A refund plus an automatic
switch to the graphic beats an error.

## 5. Worked examples

| # | post (abridged) / context | choice | why |
|---|---|---|---|
| 1 | "Onboarding used to take 3 days. Now 20 minutes." LinkedIn | motion_graphic, `stat` template 16:9 (or AI motion if 1:1), SFX only, 270 cr | S1/S2 numbers. LinkedIn bias. No scene |
| 2 | "Hot take: most founders post too much and say too little." LinkedIn + X | motion_graphic, AI motion 1:1, 10 s, 180 cr | S4 opinion. No physical nouns |
| 3 | "5 mistakes killing your Reels reach" Instagram | motion_graphic, AI motion 9:16, 15 s, music on, 330 cr | S3 list. Text is the content. Music for Reels |
| 4 | "Sunday mornings at our bakery: flour, butter, first light." Instagram, no attachments | ai_video Fast 720p 9:16, 8 s + H6 end card (≈144+54 cr) | S5 scene, little text. Fast is enough at 8 s |
| 5 | Same bakery post, publish in 2 h, "with the sound of the place" | ai_video Cinema 8 s (~25 cr, ~6 min) + H6 | S10 plus a sound need. Deadline covers latency. Cheapest engine |
| 6 | "Our new cold brew is here. ₹199 this weekend only." + bottle photo, Reels | hybrid H3: 2.5 image-to-video 5 s from the photo (195 cr) + ₹199/CTA overlays, 12 s total (≈216 graphics) ≈411 cr | S6 hero photo, S1 price, ₹ glyph needs Noto (AI motion, not template; ₹ alone is not S14) |
| 7 | "We cut delivery times 40% across Pune." Reels + LinkedIn | hybrid H2: Fast b-roll of a courier 9 s under a scrim, 40% counts up, end card | S2 stat plus S5 scene. The scrim hides Fast artifacts |
| 8 | "Introducing Autopilot: posts written, scheduled, published." + 3 UI screenshots | motion_graphic `showcase` 9:16/16:9, 288 cr | S7 UI. AI video would turn the screens to mush |
| 9 | "Congrats to our CEO Priya on Forbes 30u30!" + her photo | motion_graphic (`showcase` with the photo as a still, or AI motion) | S11 real-person policy gate. Forbes is third-party brand text, so it goes in type |
| 10 | "Join our webinar Oct 30, 6 pm IST: scaling D2C in India" LinkedIn | motion_graphic AI motion 16:9, 12 s | S1 date and time must be exact. Abstract topic (S9) |
| 11 | "Behind the scenes: our team packing 1,000 orders before Diwali" Reels | hybrid H1: Fast 6 s faceless packing hands + "1,000 orders" type, music on | S5 + S1. Hands, not faces (finger warping is acceptable at a quick cut, faces of real staff are not) |
| 12 | Any post, balance 150 cr / 22 cr | 150: sting template 7 s (126 cr). 22: the best fit, priced, `affordable: false`, cheapest = sting 126 | Cost ladder bottom. Never overdraw, never hide the plan |

## 6. Known unknowns (cheap experiments)

1. **Hybrid plumbing.** AI motion takes no raster or video input today (scaffold: "No other images").
   Test: pass a 6 s Fast clip into `assets/` and allow a `<video>` clip. Measure render time and seek determinism.
2. **Hybrid pricing.** Should hybrids charge footage seconds at the engine rate plus total seconds at 18,
   or a flat blend? Decide before shipping. This is a billing change.
3. **Seedance 2.5 vs Fast under a scrim.** Run 5 prompts on both, composite with H2, and blind-rate them.
   If Fast wins at least 4 of 5, never use 2.5 for H1/H2/H4.
4. **Seedance real-face refusal rate** for faceless and stylized people prompts on PiAPI strict models.
   Run 20 prompts and count rejections and refunds.
5. **Cinema end-frame hand-off:** render with `last_frame` = the motion graphic's first frame, for a seamless cut into type.
6. **Brain accuracy:** label 50 real past posts by hand and measure the classifier's agreement. Target ≥80% and zero text-in-footage errors.
7. **Engagement:** A/B test kinetic-only vs hybrid on the same post (Reels 3-second hold rate, LinkedIn dwell).
   The "slide in a feed" concern from §0 is untested.
8. **Fast price durability.** The vendor calls its $0.096/s a promotion. Alert if the cost per second moves.
9. **Multi-platform posts with conflicting aspects:** render once and reframe, or render twice? Measure the cost against the crop quality.
10. **Seedance peak queues** (09:00–15:00 GMT): measure p95 time-to-video from our region.
    If it exceeds 10 min, the deadline gate applies to Motion 1 as well.
