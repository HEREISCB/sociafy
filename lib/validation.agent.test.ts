import { describe, it, expect } from 'vitest';
import { agentSettingsUpdateSchema } from './validation';

describe('agentSettingsUpdateSchema', () => {
  // Exactly what onboarding's Plan step sends. A caps object covering only the
  // user's own platforms was rejected as invalid_body and blocked onboarding.
  it('accepts the onboarding plan payload', () => {
    const r = agentSettingsUpdateSchema.safeParse({
      enabledPlatforms: ['linkedin', 'instagram', 'facebook', 'youtube'],
      cadencePerWeek: 6,
      postsPerWeekByPlatform: { linkedin: 3, instagram: 4, facebook: 3, youtube: 1 },
      weeklyCreditCap: null,
      postsPerWeekByContentType: { text: 4, image: 1, video: 1 },
      autoPublishThreshold: 80,
    });
    expect(r.success).toBe(true);
  });

  it('still rejects a platform that does not exist', () => {
    expect(agentSettingsUpdateSchema.safeParse({ postsPerWeekByPlatform: { myspace: 3 } }).success).toBe(false);
  });
});
