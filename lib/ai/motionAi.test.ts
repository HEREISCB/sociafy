import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getMotionAiResult, motionAiConfigured, submitMotionAi } from './motionAi';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.MOTION_AI_URL = 'http://gpu-box:8790';
  process.env.MOTION_AI_SECRET = 's3cret';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

describe('AI motion worker client', () => {
  it('is the feature flag: needs both the URL and the secret', () => {
    expect(motionAiConfigured()).toBe(true);
    delete process.env.MOTION_AI_SECRET;
    expect(motionAiConfigured()).toBe(false);
  });

  it('submits with the secret and polls by call id', async () => {
    reply(202, { callId: 'ai-1' });
    const args = { prompt: 'Hi', aspect: '1:1' as const, durationSec: 15, brand: { brandName: 'X' }, videoKey: 'users/u/a.mp4', posterKey: 'users/u/a.jpg' };
    await expect(submitMotionAi(args)).resolves.toEqual({ callId: 'ai-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://gpu-box:8790/motion-ai/submit');
    expect(init.headers['X-Engine-Secret']).toBe('s3cret');
    expect(JSON.parse(init.body)).toEqual(args);

    reply(200, { status: 'pending' });
    await expect(getMotionAiResult('a/1')).resolves.toEqual({ status: 'pending' });
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://gpu-box:8790/motion-ai/result?callId=a%2F1');
  });

  it('throws on a non-2xx and when unconfigured, without calling out', async () => {
    reply(500, { detail: 'boom' });
    await expect(getMotionAiResult('x')).rejects.toThrow(/motion_ai_500/);
    delete process.env.MOTION_AI_URL;
    await expect(submitMotionAi({ prompt: 'p', aspect: '9:16', durationSec: 6, brand: {}, videoKey: 'k', posterKey: 'p' })).rejects.toThrow('motion_ai_not_configured');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
