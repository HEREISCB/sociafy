import { getTextAI, completeText } from '../ai/client';

export interface ScriptInput {
  brand: string;
  allegation: string;
  theme: string;
  source: string;
  severity: number;
  /** Optional brand knowledge base — approved facts, voice, and messaging the
   *  AI should ground the response in (assembled from shield_documents). */
  knowledge?: string;
  /** Optional user-customized system prompt. May contain {{variables}}
   *  (see TEMPLATE_VARS) that are substituted with live mention data. Empty
   *  string / undefined → use the built-in default prompt. */
  systemPrompt?: string;
  /** Mention author handle, for the {{author}} variable. */
  author?: string;
  /** Human-readable capture time, for the {{datetime}} variable. */
  datetime?: string;
}

/** Variables a user may use in a custom system prompt; substituted at gen time. */
export const TEMPLATE_VARS = ['brand', 'mention', 'author', 'theme', 'severity', 'source', 'datetime'] as const;

/** The default crisis-response prompt, exposed so the settings UI can show /
 *  reset to it. Mirrors the built-in SCRIPT_PROMPT but in {{variable}} form. */
export const DEFAULT_SYSTEM_PROMPT = `You are the crisis communications lead for {{brand}}. Write a 60-90 second spoken video response (150-200 words) to this mention:

"{{mention}}"
— by {{author}} · theme: {{theme}} · severity {{severity}}/10 · captured {{datetime}}

Structure: acknowledge → address the specific concern → present facts → state a concrete action → invite further contact. Empathetic but factual, no admission of unproven wrongdoing. NO stage directions, NO [brackets], NO formatting — just the script text itself.`;

/** Substitute {{var}} tokens (case-insensitive, whitespace-tolerant). Unknown
 *  tokens are left intact so a typo is visible rather than silently dropped. */
function substituteVars(template: string, input: ScriptInput): string {
  const map: Record<string, string> = {
    brand: input.brand,
    mention: input.allegation,
    allegation: input.allegation,
    author: input.author || 'a user',
    theme: input.theme,
    severity: String(input.severity),
    source: input.source,
    datetime: input.datetime || new Date().toISOString(),
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    const v = map[key.toLowerCase()];
    return v !== undefined ? v : whole;
  });
}

export interface ScriptOutput {
  script: string;
  title: string;
  keyPoints: string[];
  duration: string;
  usedAI: boolean;
}

/**
 * Per-theme framing for the fallback script — a topic phrase and a
 * process-level commitment, nothing more.
 *
 * This text ships when the AI call fails, on a PR response the user may read
 * aloud on camera. So it must contain NO facts about the user's company: no
 * security posture, no headcount, no percentages, no deadlines, no email
 * addresses, no findings. Every one of those would be a claim we invented on
 * their behalf. Keep additions to process ("we're reviewing this") — never
 * outcomes ("we found nothing").
 */
const THEME_FRAMING: Record<string, { concern: string; action: string }> = {
  'Data Security': {
    concern: 'concerns about how we handle data security and privacy',
    action: 'reviewing this with our security team and reporting back on what we actually find',
  },
  'Legal Action': {
    concern: 'the legal matter being discussed online',
    action: 'working through this with our legal counsel and will say more as soon as we properly can',
  },
  'Fraud/Deception': {
    concern: 'allegations about the honesty of how we operate',
    action: 'reviewing every claim being made against our own records, and we will publish what that review shows',
  },
  'Pricing': {
    concern: 'the concerns being raised about our pricing',
    action: 'reviewing how we price and where it is landing wrong for people, with our team this week',
  },
  'Product Quality': {
    concern: 'the product quality problems people have run into',
    action: 'investigating the root cause and prioritising a fix over anything else on our roadmap',
  },
  'Customer Support': {
    concern: 'the frustration with our support response times',
    action: 'working through the backlog and reviewing how our support team is resourced',
  },
  'Workplace Issues': {
    concern: 'the concerns raised about our workplace',
    action: 'taking these seriously, looking into them properly, and acting on what we learn',
  },
  'General Reputation': {
    concern: 'the concerns being raised about us online',
    action: 'reviewing the feedback carefully and acting on what holds up',
  },
};

/**
 * Deliberately generic holding statement. Structure mirrors what the AI is
 * asked for (acknowledge → address → position → action → invite contact) so a
 * fallback still reads like a real response, minus any invented specifics.
 */
function fallbackScript(brand: string, theme: string): string {
  const t = THEME_FRAMING[theme] ?? THEME_FRAMING['General Reputation'];
  return `Hi, I'm speaking on behalf of ${brand}.

We've seen ${t.concern}, and I want to address it directly rather than let it sit unanswered.

I'm not going to give you a rehearsed non-answer, and I'm not going to make claims today that I can't stand behind tomorrow. You deserve accuracy from us more than you deserve speed.

Here is what we are doing right now: we are ${t.action}. When we have something substantive to share, we will share it publicly — including anything that does not reflect well on us.

If this has affected you personally, or you have information that would help us understand it better, please reach out through the contact details on our website. Every message gets read by a person.

Trust is rebuilt by what we do next, not by what we say today. We know that, and we expect to be judged on it.`;
}

const SCRIPT_PROMPT = (brand: string, theme: string, severity: number, allegation: string) =>
  `You are a crisis communications expert. Write a 60-90 second video response script for "${brand}".

Crisis details:
- Theme: ${theme}
- Severity: ${severity}/10
- Context: "${allegation.slice(0, 250)}"

Requirements:
- Natural spoken language, 150-200 words
- Acknowledge → Address specific concern → Present facts → State concrete action → Invite engagement
- Empathetic but factual tone, no admission of unproven wrongdoing
- End with a specific, actionable commitment
- NO stage directions, NO [brackets], NO formatting — just the script text itself`;

/** Assemble the final prompt: a user's custom system prompt (with variables
 *  substituted) when set, else the built-in default — then append the brand
 *  knowledge base if any. */
function buildPrompt(input: ScriptInput): string {
  const custom = input.systemPrompt?.trim();
  const base = custom
    ? substituteVars(custom, input)
    : SCRIPT_PROMPT(input.brand, input.theme, input.severity, input.allegation);
  const knowledgeBlock = input.knowledge
    ? `\n\nBrand knowledge base — use ONLY these approved facts, voice, and messaging. Do not invent facts or contradict anything here:\n"""\n${input.knowledge}\n"""`
    : '';
  return base + knowledgeBlock;
}

export async function generateScript(input: ScriptInput): Promise<ScriptOutput> {
  const { brand, theme } = input;
  const prompt = buildPrompt(input);

  // Highest-stakes text we generate, so ask for the smart tier. getTextAI +
  // completeText own the OpenAI-vs-Groq split and send the right params for
  // each: this used to hand-roll the resolution and post gpt-5 a
  // chat.completions call with `max_tokens`/`temperature`, both of which gpt-5
  // rejects — so every response silently fell through to the template below.
  const ai = getTextAI('smart');
  if (ai) {
    try {
      // Budget well above the ~300 tokens a 200-word script needs: gpt-5 spends
      // output budget on reasoning before it emits a single word, and a
      // truncated script is indistinguishable here from no script at all.
      const script = await completeText(ai, {
        system: prompt,
        user: 'Write the response script now. Output only the script text.',
        maxOutputTokens: 1500,
      });
      if (script.length > 80) {
        return buildOutput(script, brand, theme, true);
      }
      // Not an exception, but just as invisible: log it or we're back to
      // shipping canned templates and calling them AI.
      console.error(`[shield] script generation returned ${script.length} chars from ${ai.kind}/${ai.model} — falling back to template`);
    } catch (e) {
      console.error(
        `[shield] script generation failed on ${ai.kind}/${ai.model}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    console.error('[shield] script generation skipped: no OPENAI_API_KEY or GROQ_API_KEY — falling back to template');
  }

  return buildOutput(fallbackScript(brand, theme), brand, theme, false);
}

function buildOutput(script: string, brand: string, theme: string, usedAI: boolean): ScriptOutput {
  const words = script.split(/\s+/).length;
  const secs = Math.ceil(words / 2.4); // ~144 wpm speaking pace
  const m = Math.floor(secs / 60);
  const s = secs % 60;

  return {
    script,
    title: `${brand} — Official Response: ${theme}`,
    keyPoints: extractKeyPoints(script),
    duration: m > 0 ? `${m}m ${s}s` : `${s}s`,
    usedAI,
  };
}

function extractKeyPoints(script: string): string[] {
  const sentences = script
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 25);
  const actionRx = /we (are|have|will|commit|promis|immediately|launch|publish|implement|deploy)|action|fix|resolv|address|contact|within|hours|days|week/i;
  const hits = sentences.filter(s => actionRx.test(s)).slice(0, 3);
  return hits.length >= 2 ? hits : sentences.slice(0, 3);
}
