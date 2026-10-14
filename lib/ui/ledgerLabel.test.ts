import { describe, expect, it } from 'vitest';
import { ledgerRowLabel } from './ledgerLabel';

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
