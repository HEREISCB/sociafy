/**
 * One style rule set for every prompt that writes PUBLIC text (posts, captions,
 * Autopilot drafts, on-screen copy, PR scripts). These go out under the
 * customer's name, so machine-writing tells cost them more than anywhere else.
 * Import this; don't restate the rules in individual prompts.
 */

const HYPE_WORDS = [
  'seamless', 'effortless', 'elevate', 'unlock', 'supercharge', 'empower', 'leverage', 'harness',
  'revolutionize', 'game-changer', 'cutting-edge', 'robust', 'delve', 'tapestry',
];

/** The subset that applies to short on-screen text. The motion-ai worker's
 *  CLAUDE.md / footage-edit.md carry this line verbatim (voice-rules.test.ts checks). */
export const ON_SCREEN_TEXT_RULE =
  `No em dashes (—) and no " - " used as a dash; no hype words (${HYPE_WORDS.join(', ')}); no rhetorical-question hooks.`;

export const VOICE_RULES = [
  'Writing style (this is published under the customer\'s name and must read like they wrote it):',
  '- No em dashes (—) and no " - " used as a dash. Use a period, comma, colon or parentheses instead.',
  `- Never use these words: ${HYPE_WORDS.join(', ')}.`,
  '- No stock phrases: "In today\'s…", "Here\'s the thing", "Let that sink in", "Whether you\'re X or Y", "It\'s not just X, it\'s Y", "Say goodbye to", "Take your X to the next level".',
  '- Don\'t open with a rhetorical question. Open with a specific claim, detail, number or moment.',
  '- No rhythm triplets ("fast, simple, powerful"). Use a list only when the content really is a list.',
  '- Hashtags: only where the platform notes allow them, a few relevant ones, never a wall.',
  '- Emoji: follow the brand voice and the platform notes; otherwise at most one, never one per line.',
  '- No engagement bait at the end ("What do you think? 👇", "Agree?", "Drop a comment below"). A call to action only when the task asks for one, and then a specific one.',
].join('\n');

// URLs, inline code and fenced code are copied through untouched.
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|\bhttps?:\/\/\S+|\bwww\.\S+/g;
const NUM = /\d/;
const MONEY_OR_DIGIT = /^[$€£₹]?\d/;
const BEFORE_PUNCT = /[.!?,;:]/;
const AFTER_PUNCT = /^[.!?,;:)\]]/;
const QUOTE = /["'”’]/;

/**
 * Deterministic em-dash remover for AI output (never run it on text the user
 * typed). Rules, per run of em dashes and the spaces around it:
 *   digit—digit (5—10, $5 — $10)      → en dash range "5–10"
 *   line start (bullet/attribution)   → "- "
 *   line end                          → ":" ("." at the very end), nothing after punctuation
 *   after . ! ? , ; :                 → " " (the dash is redundant)
 *   before . , ! ? ; : )              → removed
 *   before a capital, not after quote → ". "  (a new sentence)
 *   anything else                     → ", "  (clause / parenthetical / word—word)
 */
export function stripEmDashes(text: string): string {
  if (!text || !text.includes('—')) return text;
  const kept: string[] = [];
  const masked = text.replace(PROTECTED, (m) => `\u0000${kept.push(m) - 1}\u0000`);

  const out = masked.replace(/[ \t]*—+[ \t]*/g, (m, at: number, s: string) => {
    const prev = s[at - 1];
    const rest = s.slice(at + m.length);
    const next = rest[0];
    if (prev && NUM.test(prev) && MONEY_OR_DIGIT.test(rest)) return '–';
    if (prev === undefined || prev === '\n') return next === undefined || next === '\n' ? '' : '- ';
    if (BEFORE_PUNCT.test(prev)) return next === undefined || next === '\n' ? '' : ' ';
    if (next === undefined) return '.';
    if (next === '\n') return ':';
    if (AFTER_PUNCT.test(next)) return '';
    if (/\p{Lu}/u.test(next) && !QUOTE.test(prev)) return '. ';
    return ', ';
  });

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}
