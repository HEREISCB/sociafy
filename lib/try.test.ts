import { describe, it, expect, vi } from 'vitest';
vi.mock('./db', () => ({ db: () => ({}) }));
vi.mock('./storage/r2', () => ({ publicUrlFor: (k: string) => `https://cdn/${k}`, uploadBuffer: vi.fn() }));
import { tryView, clientIp, hashIp, type TryRow } from './try';

const row = (over: Partial<TryRow> = {}): TryRow => ({
  id: 'x', kind: 'image', prompt: 'p', aspect: null, status: 'ready', visitor: 'v', ipHash: 'h', taskId: null,
  originalKey: 'try/x/secret.png', previewUrl: 'https://cdn/try/x/preview.jpg', claimedBy: null,
  mediaAssetId: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('tryView', () => {
  it('never leaks the original to anonymous visitors', () => {
    const v = tryView(row(), null);
    expect(v.unlocked).toBe(false);
    expect(v.url).toBeNull();
    expect(JSON.stringify(v)).not.toContain('secret');
  });
  it('never leaks it to a different signed-in user', () => {
    expect(tryView(row({ claimedBy: 'alice' }), 'bob').url).toBeNull();
  });
  it('gives the owner the full file', () => {
    expect(tryView(row({ claimedBy: 'alice' }), 'alice').url).toBe('https://cdn/try/x/secret.png');
  });
  it('reports finalizing as pending', () => {
    expect(tryView(row({ status: 'finalizing' }), null).status).toBe('pending');
  });
});

describe('ip', () => {
  it('prefers Cloudflare, then the first forwarded hop', () => {
    expect(clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1');
    expect(clientIp(new Headers({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }))).toBe('2.2.2.2');
  });
  it('hashes, never stores the raw ip', () => {
    expect(hashIp('1.1.1.1')).not.toContain('1.1.1.1');
    expect(hashIp('1.1.1.1')).toBe(hashIp('1.1.1.1'));
  });
});

describe('per-IP allowance', () => {
  it('stays strict without Turnstile and loosens once it is on', async () => {
    const { tryPerIp } = await import('./try');
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(tryPerIp('video')).toBe(1);
    process.env.TURNSTILE_SECRET_KEY = 's';
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'k';
    expect(tryPerIp('video')).toBe(3);
    expect(tryPerIp('image')).toBe(6);
    delete process.env.TURNSTILE_SECRET_KEY;
  });
});
