import { describe, it, expect, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
}));
vi.mock('./db', () => ({ db: () => ({}) }));

import { aiProviderHint } from './api';

describe('aiProviderHint', () => {
  it('maps OpenAI insufficient_quota to ai_unavailable', () => {
    const e = Object.assign(new Error('429 You exceeded your current quota'), {
      status: 429,
      code: 'insufficient_quota',
    });
    const hint = aiProviderHint(e);
    expect(hint?.error).toBe('ai_unavailable');
    expect(hint?.hint).toMatch(/quota/i);
  });

  it('maps invalid_api_key to ai_unavailable', () => {
    const e = Object.assign(new Error('401 Incorrect API key'), {
      status: 401,
      code: 'invalid_api_key',
    });
    expect(aiProviderHint(e)?.error).toBe('ai_unavailable');
  });

  it('maps provider 429 rate limits (without quota code) to ai_busy', () => {
    const e = Object.assign(new Error('429 Rate limit reached'), {
      status: 429,
      code: 'rate_limit_exceeded',
    });
    expect(aiProviderHint(e)?.error).toBe('ai_busy');
  });

  it('returns null for ordinary errors so they fall through to 500', () => {
    expect(aiProviderHint(new Error('column "x" does not exist'))).toBeNull();
    expect(aiProviderHint(null)).toBeNull();
    expect(aiProviderHint('string error')).toBeNull();
  });
});
