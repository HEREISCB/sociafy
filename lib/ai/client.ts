import OpenAI from 'openai';

let _client: OpenAI | null = null;

/**
 * Singleton OpenAI client. Returns null when no API key is configured —
 * callers fall through to deterministic stub responses so the app works
 * locally without an OpenAI account.
 */
export function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_client) return _client;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/**
 * Backwards-compat shim. Old code calls getAnthropic() — we keep the same
 * boolean semantics (null when no AI configured) so stub fallbacks keep
 * working. The actual client returned is OpenAI now.
 */
export const getAnthropic = getOpenAI;

// Model defaults. Env-overridable so callers can pick a cheaper model if
// they want. Resolved lazily so an unset env var doesn't crash module load.
// `image` is the only one that doesn't have a hard-coded fallback we trust
// to remain stable — OpenAI rotates image-gen model names faster than chat
// models. Keep it env-configurable so we never have to ship a code change
// when a new generation drops.
// Deliberately the floating `gpt-image-2` tag, not the `-2026-04-21` snapshot:
// the tag picks up quality/latency improvements for free, and we have no
// image-output regression tests that would catch a bad snapshot anyway — so
// pinning would buy us nothing but a stale model. Pin via env if that changes.
export const MODELS = {
  fast: process.env.OPENAI_MODEL_FAST || 'gpt-5-mini',
  smart: process.env.OPENAI_MODEL || 'gpt-5',
  image: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
} as const;

// Groq — OpenAI-compatible endpoint. Used as fallback when OPENAI_API_KEY
// is absent but GROQ_API_KEY is set. Free tier is generous for shield scripts.
let _groq: OpenAI | null = null;

export function getGroq(): OpenAI | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  if (_groq) return _groq;
  _groq = new OpenAI({
    apiKey: key,
    baseURL: 'https://api.groq.com/openai/v1',
  });
  return _groq;
}

export const GROQ_MODELS = {
  fast: 'llama-3.3-70b-versatile',
} as const;

/**
 * A resolved text-generation provider. `kind` matters because the two
 * providers speak different APIs: OpenAI gets the Responses API (and its
 * hosted tools), Groq only implements chat.completions. `completeText`
 * hides that split; anything needing a tool loop must check `supportsTools`.
 */
export type TextAI = {
  client: OpenAI;
  kind: 'openai' | 'groq';
  model: string;
  /** Tool loops require the Responses API + OpenAI-hosted web_search. */
  supportsTools: boolean;
};

/**
 * Resolve a text provider: OpenAI when it's configured, otherwise Groq.
 * Returns null only when neither key is set — that's the one case where
 * callers should fall through to their stub output.
 *
 * Groq exposes a single model, so both tiers map onto it. That's deliberate:
 * a missing `smart` tier should degrade to a weaker real model, not to a
 * canned stub.
 */
export function getTextAI(tier: keyof typeof MODELS = 'fast'): TextAI | null {
  const openai = getOpenAI();
  if (openai) {
    return { client: openai, kind: 'openai', model: MODELS[tier], supportsTools: true };
  }
  const groq = getGroq();
  if (groq) {
    return { client: groq, kind: 'groq', model: GROQ_MODELS.fast, supportsTools: false };
  }
  return null;
}

/**
 * One-shot system+user completion that works on either provider.
 * Set `json` when the caller will JSON.parse the result — it turns on the
 * provider's JSON mode, which both otherwise like to wrap objects in prose or
 * markdown fences. The two APIs spell it differently (`text.format` on the
 * Responses API, `response_format` on chat.completions), which is exactly the
 * kind of split this helper exists to hide.
 */
export async function completeText(
  ai: TextAI,
  opts: { system: string; user: string; maxOutputTokens: number; json?: boolean; timeoutMs?: number },
): Promise<string> {
  const reqOpts = opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined;

  if (ai.kind === 'openai') {
    const resp = await ai.client.responses.create(
      {
        model: ai.model,
        input: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        max_output_tokens: opts.maxOutputTokens,
        ...(opts.json ? { text: { format: { type: 'json_object' as const } } } : {}),
        // gpt-5 models burn output budget on reasoning before emitting text;
        // keep effort low so the answer itself is never truncated.
        ...(ai.model.startsWith('gpt-5') ? { reasoning: { effort: 'low' as const } } : {}),
      },
      reqOpts,
    );
    return (resp.output_text ?? '').trim();
  }

  const res = await ai.client.chat.completions.create(
    {
      model: ai.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: opts.maxOutputTokens,
      temperature: 0.7,
      ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
    },
    reqOpts,
  );
  return res.choices[0]?.message?.content?.trim() ?? '';
}
