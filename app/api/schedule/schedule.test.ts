/**
 * POST /api/schedule must not queue a post the platform will reject.
 *
 * Instagram, TikTok and YouTube all refuse text-only posts, yet quick-compose
 * defaulted to every connected platform and never attached media — half the
 * real scheduled_posts rows in production ended up `failed` with
 * `youtube_text_unsupported` / `instagram_publish_failed`, hours after a green
 * "Scheduled." toast.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  draft: null as Record<string, unknown> | null,
  accounts: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('../../../lib/db', async () => {
  const { getTableName } = await import('drizzle-orm');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowsFor = (t: any) =>
    getTableName(t) === 'drafts'
      ? (state.draft ? [state.draft] : [])
      : state.accounts;
  return {
    db: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        from: (t: any) => {
          const rows = rowsFor(t);
          return {
            where: () =>
              Object.assign(Promise.resolve(rows), {
                limit: () => Promise.resolve(rows),
                orderBy: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
              }),
          };
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: (t: any) => ({
        values: (v: Record<string, unknown>) => {
          if (getTableName(t) === 'scheduled_posts') state.inserted.push(v);
          const row = [{ id: 'sp-1', ...v }];
          return Object.assign(Promise.resolve(row), { returning: () => Promise.resolve(row) });
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    }),
  };
});

vi.mock('../../../lib/api', () => ({
  jsonError: (message: string, status = 400, extra?: Record<string, unknown>) =>
    NextResponse.json({ error: message, ...extra }, { status }),
  withUser: async (handler: (u: { id: string }) => unknown) => {
    const result = await handler({ id: 'u1' });
    return result instanceof Response ? result : NextResponse.json(result);
  },
}));

import { POST } from './route';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

const post = (body: Record<string, unknown>) =>
  POST({ json: async () => body } as unknown as NextRequest);

beforeEach(() => {
  state.draft = {
    id: DRAFT_ID, userId: 'u1', body: 'hello world',
    targetPlatforms: ['x'], perPlatformText: null, media: [],
  };
  state.accounts = [
    { id: 'a-x', platform: 'x' },
    { id: 'a-ig', platform: 'instagram' },
    { id: 'a-yt', platform: 'youtube' },
    { id: 'a-tt', platform: 'tiktok' },
  ];
  state.inserted = [];
});

describe('text-only posts to media-only platforms', () => {
  for (const platform of ['instagram', 'youtube', 'tiktok']) {
    it(`rejects a text-only post to ${platform}`, async () => {
      const res = await post({ draftId: DRAFT_ID, scheduledAt: soon(), platforms: [platform] });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('unsupported_post_type');
      expect(state.inserted).toEqual([]);
    });
  }

  it('schedules the platforms that can take it and reports why the others were skipped', async () => {
    const res = await post({
      draftId: DRAFT_ID, scheduledAt: soon(), platforms: ['x', 'instagram', 'youtube'],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.inserted.map((r) => r.platform)).toEqual(['x']);
    expect(body.skipped.sort()).toEqual(['instagram', 'youtube']);
    expect(body.reasons.instagram).toMatch(/image or video/i);
    expect(body.reasons.youtube).toMatch(/video/i);
  });

  it('allows Instagram once the draft actually carries an image', async () => {
    state.draft!.media = [{ id: 'm1', url: 'https://cdn/x.jpg', mimeType: 'image/jpeg' }];
    const res = await post({ draftId: DRAFT_ID, scheduledAt: soon(), platforms: ['instagram'] });
    expect(res.status).toBe(200);
    expect(state.inserted.map((r) => r.platform)).toEqual(['instagram']);
  });

  it('allows TikTok and YouTube once the draft carries a video', async () => {
    state.draft!.media = [{ id: 'm1', url: 'https://cdn/x.mp4', mimeType: 'video/mp4' }];
    const res = await post({ draftId: DRAFT_ID, scheduledAt: soon(), platforms: ['tiktok', 'youtube'] });
    expect(res.status).toBe(200);
    expect(state.inserted.map((r) => r.platform)).toEqual(['tiktok', 'youtube']);
  });

  it('still fails loudly when no platform is connected', async () => {
    state.accounts = [];
    const res = await post({ draftId: DRAFT_ID, scheduledAt: soon(), platforms: ['x'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_connected_accounts');
  });
});
