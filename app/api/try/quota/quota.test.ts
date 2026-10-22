import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const seen: { kind?: string; who?: Record<string, unknown> } = {};
vi.mock('../../../../lib/try', () => ({
  TRY_PER_DAY: { image: 2, video: 1 },
  VISITOR_COOKIE: 'sfy_try',
  clientIp: () => '1.1.1.1',
  hashIp: () => 'h',
  tryQuota: async (kind: string, who: Record<string, unknown>) => {
    seen.kind = kind;
    seen.who = who;
    return { left: 1, siteFull: false };
  },
}));
vi.mock('../../../../lib/api', () => ({
  authedUser: async () => null,
  jsonError: (error: string, status = 400) => Response.json({ error }, { status }),
}));

import { GET } from './route';

const req = (q: string, cookie?: string) =>
  new NextRequest(`http://x/api/try/quota${q}`, { headers: cookie ? { cookie } : {} });

describe('GET /api/try/quota', () => {
  it('reports tries left out of the daily allowance', async () => {
    const r = await GET(req('?kind=image', 'sfy_try=abc'));
    expect(await r.json()).toEqual({ left: 1, perDay: 2 });
    expect(seen).toEqual({ kind: 'image', who: { visitor: 'abc', ipHash: 'h', userId: null } });
  });
  it('works for a browser with no cookie yet', async () => {
    await GET(req('?kind=video'));
    expect(seen.who?.visitor).toBe('none');
  });
  it('rejects an unknown kind', async () => {
    expect((await GET(req('?kind=gif'))).status).toBe(400);
  });
});
