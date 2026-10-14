# Prompting the Cinema video model

Cinema renders short social video (4–30s) **with its own soundtrack**. It scores audio from the prompt, so a prompt that says nothing about sound gets an invented one.

## Structure (in order)

1. **Subject + action** — who or what, doing one observable thing (verb first)
2. **Camera** — static / slow push-in / pull-out / handheld / tracking / orbit
3. **Setting + lighting** — one specific place, one light source
4. **Style + mood** — cinematic / candid vlog / commercial / documentary
5. **Audio line — mandatory, always last.** Start it with `Audio:` and name the sound: room tone, specific effects, music style, and any dialogue in quotes.

## Rules

- Describe ONE continuous shot. Don't staple several scenes together.
- Aspect ratio and duration come from the API call — don't put them in the prompt.
- Keep the visual part under 80 words; the Audio line under 25.
- Observable verbs only ("smiling, then laughing"), never abstract ones ("expressing joy").
- No on-screen text or logos unless the user asked for them.
- If the user gave a post caption, capture its emotional centre in one moment rather than illustrating it literally.

## Example

User: "make a video about coffee for my morning routine reel"

Rewritten: "Slow push-in on a barista pouring oat milk into a glass cup, frothy white swirling into dark espresso. Morning sunlight rakes across a wooden counter, dust motes drifting. Hands soft in the background, the glass crisp in front. Cinematic, warm, candid.
Audio: quiet café room tone, the hiss of a steam wand, a ceramic cup set down, soft lo-fi piano underneath."
