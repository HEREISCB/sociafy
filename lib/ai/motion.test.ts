import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getMotionResult, motionConfigured, submitMotion } from './motion';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.MOTION_ENGINE_URL = 'https://ws--sociafy-motion-engine-fastapi-app.modal.run';
  process.env.MODAL_WEBHOOK_SECRET = 's3cret';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

describe('motion engine client', () => {
  it('is the feature flag: needs both the URL and the shared secret', () => {
    expect(motionConfigured()).toBe(true);
    delete process.env.MOTION_ENGINE_URL;
    expect(motionConfigured()).toBe(false);
    process.env.MOTION_ENGINE_URL = 'https://x';
    delete process.env.MODAL_WEBHOOK_SECRET;
    expect(motionConfigured()).toBe(false);
  });

  it('submits with the engine secret and returns the call id', async () => {
    reply(200, { callId: 'fc-1' });
    const args = { template: 'stat' as const, aspect: '9:16' as const, vars: { hook: 'Hi' }, videoKey: 'users/u/a.mp4', posterKey: 'users/u/a.jpg' };
    await expect(submitMotion(args)).resolves.toEqual({ callId: 'fc-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://ws--sociafy-motion-engine-fastapi-app.modal.run/motion/submit');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Engine-Secret']).toBe('s3cret');
    expect(JSON.parse(init.body)).toEqual(args);
  });

  it('polls the result by call id', async () => {
    reply(200, { status: 'done', videoKey: 'users/u/a.mp4' });
    await expect(getMotionResult('fc/1')).resolves.toMatchObject({ status: 'done' });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/motion\/result\?callId=fc%2F1$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('throws on a non-2xx and when unconfigured, without calling out', async () => {
    reply(401, { detail: 'bad_secret' });
    await expect(getMotionResult('x')).rejects.toThrow(/motion_401/);
    delete process.env.MOTION_ENGINE_URL;
    await expect(getMotionResult('x')).rejects.toThrow('motion_not_configured');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
