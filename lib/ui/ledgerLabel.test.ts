import { describe, expect, it } from 'vitest';
import { groupLedger, ledgerRowLabel, summarizeCycle } from './ledgerLabel';

describe('groupLedger', () => {
  const r = (id: string, kind: string, action: string | null, credits: number, at: string, meta: Record<string, unknown> | null = null) =>
    ({ id, kind, action, label: action ?? kind, credits, meta, createdAt: at });

  it('groups by local day, nets each day, and collapses adjacent identical rows', () => {
    const days = groupLedger([
      r('a', 'charge', 'agent_draft', -4, '2026-10-22T12:00:00'),
      r('b', 'charge', 'agent_draft', -4, '2026-10-22T11:00:00'),
      r('c', 'charge', 'text_post', -1, '2026-10-22T10:00:00'),
      r('d', 'charge', 'agent_draft', -4, '2026-10-22T09:00:00'),
      r('e', 'topup', null, 1000, '2026-10-21T09:00:00', { reason: 'topup' }),
    ]);
    expect(days.map((d) => [d.day, d.net])).toEqual([['2026-10-22', -13], ['2026-10-21', 1000]]);
    expect(days[0].lines.map((l) => [l.title, l.detail, l.count, l.credits])).toEqual([
      ['Caption', 'Autopilot', 2, -8],
      ['Caption', null, 1, -1],
      // Not merged with the first run: only neighbours collapse.
      ['Caption', 'Autopilot', 1, -4],
    ]);
    expect(days[1].lines[0]).toMatchObject({ title: 'Top-up', tone: 'added' });
  });

  it('never merges a refund into the charge it reverses', () => {
    const days = groupLedger([
      r('a', 'refund', 'video_8s_720p_quality', 315, '2026-10-22T12:00:00'),
      r('b', 'charge', 'video_8s_720p_quality', -315, '2026-10-22T11:00:00'),
    ]);
    expect(days[0].net).toBe(0);
    expect(days[0].lines.map((l) => l.tone)).toEqual(['refund', 'spent']);
  });
});

describe('summarizeCycle', () => {
  it('makes carriedOver + added − spent + refunded equal the balance', () => {
    const s = summarizeCycle([
      { kind: 'monthly_grant', action: null, credits: 6000 },
      { kind: 'topup', action: null, credits: 2000 },
      { kind: 'charge', action: 'video_8s_720p_quality', credits: -3150 },
      { kind: 'charge', action: 'video_motion_ai', credits: -1080 },
      { kind: 'charge', action: 'image_medium_1024', credits: -402 },
      { kind: 'refund', action: 'video_8s_720p_quality', credits: 315 },
    ], 3862);
    expect(s).toMatchObject({ added: 8000, spent: 4632, refunded: 315 });
    expect(s.carriedOver + s.added - s.spent + s.refunded).toBe(3862);
    expect(s.byCategory).toEqual([
      { category: 'Video', credits: 3150 },
      { category: 'Motion graphic', credits: 1080 },
      { category: 'Image', credits: 402 },
    ]);
  });
});

const row = (kind: string, action: string | null, label: string, meta: Record<string, unknown> | null = null) =>
  ledgerRowLabel({ kind, action, label, meta });

describe('ledgerRowLabel', () => {
  it('never shows internal refund codes', () => {
    expect(row('refund', 'video_8s_720p_quality', 'Video · 8s · 720p · Quality', { reason: 'upstream_error' }))
      .toEqual({ title: 'Refund — generation failed', detail: 'Video' });
    expect(row('refund', 'text_post', 'Text post', { reason: 'compose_stub_fallback' }))
      .toEqual({ title: 'Refund — generation failed', detail: 'Caption' });
    expect(row('refund', 'image_medium_1024', 'Image', { reason: 'partial_failure: 3/4 succeeded', partialOf: 'x' }).title)
      .toBe('Refund — some results failed');
    expect(row('refund', 'text_post_research', 'x', { reason: 'reconcile: 1 search(es), 6 credits used' }).title)
      .toBe('Refund — unused web searches');
  });

  it('names charges by what was made, not ids', () => {
    expect(row('charge', 'agent_draft', 'Agent draft', { draftId: 'c445d998aaaa' })).toEqual({ title: 'Caption', detail: 'Autopilot' });
    expect(row('charge', 'image_medium_1024', 'Image · medium · square')).toEqual({ title: 'Image', detail: 'medium · square' });
    expect(row('charge', 'video_8s_720p_quality', 'Video · 8s · 720p · Quality')).toEqual({ title: 'Video', detail: '8s · 720p · Quality' });
    expect(row('charge', 'text_post', 'Text post')).toEqual({ title: 'Caption', detail: null });
    expect(row('charge', 'brand_new_thing', 'Brand new thing')).toEqual({ title: 'Brand new thing', detail: null });
  });

  it('labels grants', () => {
    expect(row('signup_bonus', null, 'Welcome bonus', { reason: 'profile_created' })).toEqual({ title: 'Welcome bonus', detail: null });
    expect(row('monthly_grant', null, 'Monthly allocation', { reason: 'upgrade_delta' })).toEqual({ title: 'Monthly credits', detail: 'Plan upgrade' });
  });
});
