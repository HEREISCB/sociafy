import { describe, it, expect, beforeEach } from 'vitest';
import { modalConfigured } from './modal';

describe('modal client config', () => {
  beforeEach(() => {
    delete process.env.MODAL_VOICE_ENGINE_URL;
    delete process.env.MODAL_AVATAR_ENGINE_URL;
    delete process.env.MODAL_WEBHOOK_SECRET;
  });

  it('reports unconfigured when env missing', () => {
    expect(modalConfigured('voice')).toBe(false);
    expect(modalConfigured('avatar')).toBe(false);
  });

  it('requires both base URL and secret', () => {
    process.env.MODAL_VOICE_ENGINE_URL = 'https://x.modal.run';
    expect(modalConfigured('voice')).toBe(false); // no secret yet
    process.env.MODAL_WEBHOOK_SECRET = 's';
    expect(modalConfigured('voice')).toBe(true);
    expect(modalConfigured('avatar')).toBe(false); // avatar URL still missing
  });

  it('configures engines independently', () => {
    process.env.MODAL_WEBHOOK_SECRET = 's';
    process.env.MODAL_AVATAR_ENGINE_URL = 'https://a.modal.run';
    expect(modalConfigured('avatar')).toBe(true);
    expect(modalConfigured('voice')).toBe(false);
  });
});
