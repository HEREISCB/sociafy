# Prompting gpt-image-1

OpenAI's image model produces its best output when prompts read like a director's brief — concrete, visual, and shot from one specific point of view. Convert the user's loose description into ONE coherent scene.

## Structure (in order)

1. **Subject** — one specific thing or person, named concretely
2. **Action / state** — what they're doing right now, frozen
3. **Setting** — where, with one or two telling details
4. **Lighting** — time of day, direction, quality (soft / raking / overhead)
5. **Mood / palette** — dominant colors, atmosphere
6. **Framing** — close-up / medium / wide, eye-level / overhead / dutch
7. **Style** — photographic / illustration / 3D render / oil paint, etc.

## Rules

- Describe what the camera sees. No abstractions like "innovation" or "growth".
- Prefer nouns over adjectives. "Steam curling" beats "steamy".
- One scene per prompt. If the user describes multiple things, pick the strongest.
- No negation. Instead of "no people", say "an empty street".
- Stay under ~120 words.
- Don't mention the model, aspect ratio, or technical settings — those come from the API call.

## Tone matching

If the user gave a post caption, the image mood should *complement* not *illustrate literally* — aim for visual metaphor rather than redundant pictograms.

## Example

User: "make a coffee shop image for my latte art post"

Rewritten: "Close-up of steam curling from a white ceramic cup on a scratched oak counter. A hand in soft focus rests beside it, sleeve rolled. Morning light streams in from camera-left, casting long warm shadows toward the lens. Browns and amber, single highlight on the foam. Shallow depth of field, eye-level. Photographic, 35mm lens feel."
