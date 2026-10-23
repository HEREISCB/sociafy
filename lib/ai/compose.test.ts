import { describe, it, expect, vi } from 'vitest';

/** generateCompose: the shared voice rules reach the prompt, and em dashes never reach the user. */
const st = vi.hoisted(() => ({ system: '', reply: '' }));
vi.mock('./client', () => ({
  getTextAI: () => ({ kind: 'openai', model: 'm', supportsTools: false }),
  completeText: async (_ai: unknown, o: { system: string }) => {
    st.system = o.system;
    return st.reply;
  },
}));

import { generateCompose } from './compose';
import { VOICE_RULES } from './voice-rules';

describe('generateCompose', () => {
  it('puts VOICE_RULES in the system prompt and strips em dashes from variants and per-platform copy', async () => {
    st.reply = JSON.stringify({
      variants: [{ label: 'A', text: 'We shipped — and it worked. https://a.co/x—y', score: 80 }],
      perPlatform: { x: 'Fast—cheap', linkedin: 'Line one —\nLine two' },
    });
    const r = await generateCompose({ prompt: 'launch', platforms: ['x', 'linkedin'], count: 1 });
    expect(st.system).toContain(VOICE_RULES);
    expect(r.variants[0].text).toBe('We shipped, and it worked. https://a.co/x—y');
    expect(r.perPlatform).toEqual({ x: 'Fast, cheap', linkedin: 'Line one:\nLine two' });
  });
});
