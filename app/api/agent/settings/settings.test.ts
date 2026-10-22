/** A user's first settings row starts on "Post automatically" (threshold 1), same as the column default. */
import { describe, it, expect, vi } from 'vitest';

const inserted = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../../../../lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: async () => [v] }; } }),
  }),
}));
vi.mock('../../../../lib/api', () => ({
  withUser: async (handler: (u: { id: string }) => unknown) => Response.json(await handler({ id: 'user_abc' })),
}));
vi.mock('../../../../lib/ai/brand-brief', () => ({ buildBrandBrief: vi.fn() }));
vi.mock('../../../../lib/cron/trends', () => ({ refreshTrendsForUser: vi.fn() }));
vi.mock('../../../../lib/agent/run', () => ({ runAgentForUser: vi.fn() }));

import { GET } from './route';
import { agentSettings } from '../../../../lib/db/schema';

describe('new autopilot settings', () => {
  it('default to Post automatically: every rated draft (score >= 1) is scheduled', async () => {
    const row = await (await GET()).json();
    expect(inserted[0].autoPublishThreshold).toBe(1);
    expect(row.autoPublishThreshold).toBe(1);
    expect(agentSettings.autoPublishThreshold.default).toBe(1);
  });
});
