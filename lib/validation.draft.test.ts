import { describe, it, expect } from 'vitest';
import { draftUpdateSchema } from './validation';

describe('draft variants', () => {
  it('keeps autopilot per-platform copy and a mid-render approval through a save', () => {
    const v = { label: 'A', text: 't', perPlatform: { x: 'short' }, approved: true };
    const r = draftUpdateSchema.safeParse({ variants: [v] });
    expect(r.success && r.data.variants?.[0]).toEqual(v);
  });
});
