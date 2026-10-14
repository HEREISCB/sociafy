import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

vi.mock('../env', () => ({
  env: {
    platforms: {
      meta: { appId: 'fbapp', appSecret: 'fbsecret', configId: null, webhookVerifyToken: 'vtok' },
      instagram: { appId: 'igapp', appSecret: 'igsecret' },
      tiktok: {},
    },
  },
}));
vi.mock('../storage/r2', () => ({ uploadBuffer: vi.fn() }));
vi.mock('../rate-limit', () => ({ rateLimit: () => ({ ok: true }), requestIp: () => 'ip' }));
// Status lookups find no activity_log row — exercises the HMAC path.
vi.mock('../db', () => ({
  db: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) }),
}));

import {
  facebookCallbackConfig,
  handleDataDeletionStatus,
  handleWebhookGet,
  instagramWebhookAdapter,
  issueDeletionCode,
  parseSignedRequest,
} from './webhook';
import { revokeAtPlatform } from './revoke';

const hub = (secret: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

function signedRequest(secret: string, payload: object) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${crypto.createHmac('sha256', secret).update(p).digest('base64url')}.${p}`;
}

describe('instagram webhook signature', () => {
  const body = '{"object":"instagram","entry":[]}';
  it.each(['igsecret', 'fbsecret'])('accepts a signature made with %s', (secret) => {
    expect(instagramWebhookAdapter.verify({ rawBody: body, headers: new Headers({ 'x-hub-signature-256': hub(secret, body) }) })).toBe(true);
  });
  it('rejects other secrets', () => {
    expect(instagramWebhookAdapter.verify({ rawBody: body, headers: new Headers({ 'x-hub-signature-256': hub('nope', body) }) })).toBe(false);
  });
});

describe('verify-token challenge', () => {
  const get = (tok: string) =>
    handleWebhookGet(new NextRequest(`http://t/x?hub.mode=subscribe&hub.verify_token=${tok}&hub.challenge=42`), instagramWebhookAdapter);
  it('echoes the challenge only for the right token', async () => {
    expect(await get('vtok').text()).toBe('42');
    expect(await get('vtox').text()).not.toBe('42');
    expect(await get('v').text()).not.toBe('42');
  });
});

describe('parseSignedRequest', () => {
  it('round-trips a valid request and rejects a wrong secret', () => {
    const sr = signedRequest('fbsecret', { user_id: 'u1', algorithm: 'HMAC-SHA256' });
    expect(parseSignedRequest(sr, 'fbsecret')?.user_id).toBe('u1');
    expect(parseSignedRequest(sr, 'other')).toBeNull();
    expect(parseSignedRequest(sr, null)).toBeNull();
  });
});

describe('data deletion status', () => {
  const status = async (code: string) =>
    (await handleDataDeletionStatus(new NextRequest(`http://t/s?code=${code}`), facebookCallbackConfig)).json();
  it('reports completed for a code we issued even with no deletion row', async () => {
    expect((await status(issueDeletionCode('fbsecret'))).status).toBe('completed');
  });
  it('reports not_found for a code we did not issue', async () => {
    expect((await status('0'.repeat(32))).status).toBe('not_found');
  });
});

describe('revokeAtPlatform(facebook)', () => {
  it('resolves the user via debug_token and DELETEs their permissions with the app token', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(url.includes('debug_token') ? { data: { user_id: 'u1' } } : { success: true }));
    }));
    await revokeAtPlatform('facebook', { accessToken: 'PAGE', refreshToken: null });
    expect(calls[0].url).toContain('/debug_token?input_token=PAGE');
    expect(calls[1]).toEqual({
      url: `https://graph.facebook.com/v25.0/u1/permissions?access_token=${encodeURIComponent('fbapp|fbsecret')}`,
      method: 'DELETE',
    });
  });

  it('warns instead of swallowing failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 400 })));
    await revokeAtPlatform('facebook', { accessToken: 'PAGE', refreshToken: null });
    expect(warn).toHaveBeenCalled();
  });
});
