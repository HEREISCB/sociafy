import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import OpenAI from 'openai';
import { getTextAI, completeText, GROQ_MODELS, MODELS, type TextAI } from './client';

const OPENAI = process.env.OPENAI_API_KEY;
const GROQ = process.env.GROQ_API_KEY;

describe('getTextAI provider selection', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    if (OPENAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = OPENAI;
    if (GROQ === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = GROQ;
  });

  it('returns null when no provider is configured', () => {
    expect(getTextAI('fast')).toBeNull();
  });

  it('prefers OpenAI when both keys are set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk-test';
    const p = getTextAI('smart');
    expect(p?.kind).toBe('openai');
    expect(p?.model).toBe(MODELS.smart);
  });

  it('falls back to Groq when only GROQ_API_KEY is set', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    const p = getTextAI('fast');
    expect(p?.kind).toBe('groq');
    expect(p?.model).toBe(GROQ_MODELS.fast);
  });

  // Groq has no `smart` tier — both tiers resolve to its one supported model
  // rather than returning null and silently dropping the caller to a stub.
  it('serves the smart tier from Groq too', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    expect(getTextAI('smart')?.model).toBe(GROQ_MODELS.fast);
  });

  // Tool loops need OpenAI's hosted web_search + Responses API. Callers branch
  // on this to decide whether to run the agent loop or a single-shot call.
  it('marks only OpenAI as tool-capable', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    expect(getTextAI('fast')?.supportsTools).toBe(false);
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getTextAI('fast')?.supportsTools).toBe(true);
  });
});

/**
 * completeText is where the real risk lives: the two providers take different
 * methods and different parameter names for the same three things (output cap,
 * JSON mode, reasoning). Getting one wrong doesn't fail loudly — it throws
 * inside a caller's try/catch and silently degrades to stub/template output,
 * which is exactly how `max_tokens` on gpt-5 shipped to production unnoticed.
 *
 * So these tests assert on the request that goes out, not just the text back.
 */
type Call = [params: Record<string, unknown>, opts?: Record<string, unknown>];

/** Fake OpenAI-shaped client recording both API surfaces. */
function fakeClient(reply: { openai?: unknown; groq?: unknown } = {}) {
  const calls = { responses: [] as Call[], chat: [] as Call[] };
  const client = {
    responses: {
      create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
        calls.responses.push([params, opts]);
        return reply.openai ?? { output_text: '  openai said this  ' };
      },
    },
    chat: {
      completions: {
        create: async (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.chat.push([params, opts]);
          return reply.groq ?? { choices: [{ message: { content: '  groq said this  ' } }] };
        },
      },
    },
  };
  return { calls, client: client as unknown as OpenAI };
}

function ai(kind: 'openai' | 'groq', model: string, client: OpenAI): TextAI {
  return { client, kind, model, supportsTools: kind === 'openai' };
}

describe('completeText — OpenAI (Responses API)', () => {
  it('calls responses.create, never chat.completions', async () => {
    const f = fakeClient();
    const out = await completeText(ai('openai', 'gpt-5', f.client), {
      system: 'sys', user: 'usr', maxOutputTokens: 900,
    });
    expect(f.calls.chat).toHaveLength(0);
    expect(f.calls.responses).toHaveLength(1);
    expect(out).toBe('openai said this');

    const [params] = f.calls.responses[0];
    expect(params.model).toBe('gpt-5');
    expect(params.input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    // Responses API spells the output cap max_output_tokens. `max_tokens` here
    // is a 400 from the API.
    expect(params.max_output_tokens).toBe(900);
    expect(params).not.toHaveProperty('max_tokens');
    // …and rejects `temperature` on gpt-5, so we must never send it.
    expect(params).not.toHaveProperty('temperature');
  });

  it('sends reasoning effort low only for gpt-5 models', async () => {
    const five = fakeClient();
    await completeText(ai('openai', 'gpt-5-mini', five.client), { system: 's', user: 'u', maxOutputTokens: 100 });
    expect(five.calls.responses[0][0].reasoning).toEqual({ effort: 'low' });

    const four = fakeClient();
    await completeText(ai('openai', 'gpt-4o', four.client), { system: 's', user: 'u', maxOutputTokens: 100 });
    expect(four.calls.responses[0][0]).not.toHaveProperty('reasoning');
  });

  // The whole point of the `json` flag: agent.ts and compose.ts JSON.parse the
  // return value. It used to only take effect on Groq, leaving the primary
  // provider free to wrap the object in prose and blow up the parse.
  it('turns on JSON mode via text.format when json is set', async () => {
    const f = fakeClient();
    await completeText(ai('openai', 'gpt-5', f.client), { system: 's', user: 'u', maxOutputTokens: 100, json: true });
    expect(f.calls.responses[0][0].text).toEqual({ format: { type: 'json_object' } });
  });

  it('omits text.format when json is not set', async () => {
    const f = fakeClient();
    await completeText(ai('openai', 'gpt-5', f.client), { system: 's', user: 'u', maxOutputTokens: 100 });
    expect(f.calls.responses[0][0]).not.toHaveProperty('text');
  });

  it('returns empty string when the model emits no text', async () => {
    const f = fakeClient({ openai: {} });
    expect(await completeText(ai('openai', 'gpt-5', f.client), { system: 's', user: 'u', maxOutputTokens: 10 })).toBe('');
  });
});

describe('completeText — Groq (chat.completions)', () => {
  it('calls chat.completions.create, never responses', async () => {
    const f = fakeClient();
    const out = await completeText(ai('groq', GROQ_MODELS.fast, f.client), {
      system: 'sys', user: 'usr', maxOutputTokens: 450,
    });
    expect(f.calls.responses).toHaveLength(0);
    expect(f.calls.chat).toHaveLength(1);
    expect(out).toBe('groq said this');

    const [params] = f.calls.chat[0];
    expect(params.model).toBe(GROQ_MODELS.fast);
    expect(params.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    // chat.completions spells it max_tokens, and Groq has no reasoning param.
    expect(params.max_tokens).toBe(450);
    expect(params).not.toHaveProperty('max_output_tokens');
    expect(params).not.toHaveProperty('reasoning');
    expect(params.temperature).toBe(0.7);
  });

  it('sets response_format when json is set, omits it otherwise', async () => {
    const on = fakeClient();
    await completeText(ai('groq', GROQ_MODELS.fast, on.client), { system: 's', user: 'u', maxOutputTokens: 10, json: true });
    expect(on.calls.chat[0][0].response_format).toEqual({ type: 'json_object' });

    const off = fakeClient();
    await completeText(ai('groq', GROQ_MODELS.fast, off.client), { system: 's', user: 'u', maxOutputTokens: 10 });
    expect(off.calls.chat[0][0]).not.toHaveProperty('response_format');
  });

  it('returns empty string when the choice has no content', async () => {
    const f = fakeClient({ groq: { choices: [] } });
    expect(await completeText(ai('groq', GROQ_MODELS.fast, f.client), { system: 's', user: 'u', maxOutputTokens: 10 })).toBe('');
  });
});

describe('completeText — request options', () => {
  // prompt-rewriter.ts relies on this: a slow rewrite must abort rather than
  // hold up media generation.
  it('forwards timeoutMs as a per-request timeout on both providers', async () => {
    const o = fakeClient();
    await completeText(ai('openai', 'gpt-5', o.client), { system: 's', user: 'u', maxOutputTokens: 10, timeoutMs: 12_000 });
    expect(o.calls.responses[0][1]).toEqual({ timeout: 12_000 });

    const g = fakeClient();
    await completeText(ai('groq', GROQ_MODELS.fast, g.client), { system: 's', user: 'u', maxOutputTokens: 10, timeoutMs: 5_000 });
    expect(g.calls.chat[0][1]).toEqual({ timeout: 5_000 });
  });

  it('passes no request options when timeoutMs is absent', async () => {
    const f = fakeClient();
    await completeText(ai('openai', 'gpt-5', f.client), { system: 's', user: 'u', maxOutputTokens: 10 });
    expect(f.calls.responses[0][1]).toBeUndefined();
  });
});
