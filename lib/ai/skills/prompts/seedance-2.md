# Prompting Seedance 2.0 (Bytedance)

Seedance is a short-form video model (4–15s) optimized for social. Prompts should be **verb-led** and describe a single continuous beat — Seedance handles motion better when the action is concrete.

## Structure (in order)

1. **Subject + action** — "a young woman walking through…" (verb first)
2. **Camera motion** — static / slow push-in / pull-out / handheld / tracking / orbit
3. **Setting + lighting** — one specific place, one light source
4. **Style + mood** — cinematic / candid vlog / commercial / documentary / dreamy
5. **End-state (optional)** — only if the action resolves somewhere

## Rules

- Lead with the verb, not the subject. "Slow push-in on…" beats "There is…"
- One continuous action. Don't try to staple multiple shots together.
- Specify camera framing changes if needed: "starts on her face, pulls back to reveal…"
- Aspect ratio and duration come from the API call — don't put them in the prompt.
- Keep under 80 words. Longer prompts dilute motion fidelity.
- Avoid abstract verbs ("expressing joy"). Use observable ones ("smiling, then laughing").

## Tone matching

If the user gave a post caption, the video should *set the mood* of the caption — generally one specific moment that captures the post's emotional center, not a literal illustration.

## Example

User: "make a video about coffee for my morning routine reel"

Rewritten: "Slow push-in on a barista pouring oat milk into a glass cup — frothy white meets dark espresso. Morning sunlight rakes across a wooden counter, dust motes drifting. Hands stay in soft focus, the glass crisp in foreground. Cinematic, candid, no music cue. Eight seconds."
