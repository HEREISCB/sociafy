import * as https from 'node:https';

/**
 * PiAPI Seedance 2.0 video-gen client.
 *
 * Same TLS-hardened path as our OpenAI direct fallback — explicit
 * https.request with TLS 1.2 + http/1.1 + IPv4. PiAPI's edge is Cloudflare
 * so it's already friendly, but the cap is cheap insurance against the
 * Windows-AV / TLS-1.3 class of issues that bit us on OpenAI.
 *
 * API contract (https://piapi.ai/docs/seedance-api/seedance-2):
 *   POST https://api.piapi.ai/api/v1/task
 *   GET  https://api.piapi.ai/api/v1/task/{task_id}
 *   Header: `X-API-Key: <key>`
 *
 * The create response wraps the task in `{ code, data, message }`. The
 * status field is title-case (`Pending | Processing | Completed | Failed
 * | Staged`). On Completed, `data.output.video` is the URL.
 */

const HOST = 'api.piapi.ai';

const sharedAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
  family: 4,
});

function piapiRequest<T>(opts: {
  method: 'GET' | 'POST';
  path: string;
  apiKey: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'X-API-Key': opts.apiKey,
      'Accept': 'application/json',
      'User-Agent': 'sociafy/1.0',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(
      {
        hostname: HOST,
        port: 443,
        path: opts.path,
        method: opts.method,
        headers,
        agent: sharedAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`piapi_${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export type SeedanceMode = 'text_to_video' | 'first_last_frames' | 'omni_reference';
export type SeedanceQuality = '480p' | '720p' | '1080p';
export type SeedanceAspect = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | 'auto';

export type CreateSeedanceTaskArgs = {
  prompt: string;
  mode: SeedanceMode;
  durationSec: number;
  aspect: SeedanceAspect;
  resolution: SeedanceQuality;
  /** First (and optional last) frame for first_last_frames, or reference set for omni_reference. */
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  /** "seedance-2" (quality) or "seedance-2-fast" (fast). Default quality. */
  fast?: boolean;
  /**
   * Opt-in push notification (https://piapi.ai/docs/unified-webhook). PiAPI
   * POSTs `{ timestamp, data: { task_id, status, output, error } }` to
   * `endpoint` on `completed` / `failed` and echoes `secret` back verbatim in
   * the `x-webhook-secret` header — so it's a shared bearer token, NOT an HMAC
   * over the body. Keep it high-entropy and compare in constant time.
   *
   * Optional so the first-party path (which polls) is byte-identical to before.
   */
  webhookConfig?: { endpoint: string; secret: string };
};

type PiapiCreateResponse = {
  code: number;
  data: { task_id: string; status: string };
  message: string;
};

export async function createSeedanceTask(args: CreateSeedanceTaskArgs & { apiKey: string }): Promise<string> {
  const body = {
    model: 'seedance',
    task_type: args.fast ? 'seedance-2-fast' : 'seedance-2',
    input: {
      prompt: args.prompt,
      mode: args.mode,
      duration: args.durationSec,
      aspect_ratio: args.aspect,
      resolution: args.resolution,
      ...(args.imageUrls && args.imageUrls.length ? { image_urls: args.imageUrls } : {}),
      ...(args.videoUrls && args.videoUrls.length ? { video_urls: args.videoUrls } : {}),
      ...(args.audioUrls && args.audioUrls.length ? { audio_urls: args.audioUrls } : {}),
    },
    // `config` is a sibling of `input`, not nested inside it.
    ...(args.webhookConfig ? { config: { webhook_config: args.webhookConfig } } : {}),
  };
  const res = await piapiRequest<PiapiCreateResponse>({
    method: 'POST',
    path: '/api/v1/task',
    apiKey: args.apiKey,
    body,
    timeoutMs: 30_000,
  });
  if (!res?.data?.task_id) {
    throw new Error(`piapi_no_task_id: ${JSON.stringify(res).slice(0, 400)}`);
  }
  return res.data.task_id;
}

export type SeedanceTaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'staged';

export type GetSeedanceTaskResult = {
  status: SeedanceTaskStatus;
  videoUrl?: string;
  error?: string;
};

type PiapiGetResponse = {
  code: number;
  data: {
    task_id: string;
    status: string;
    output?: { video?: string };
    error?: { message?: string; code?: string | number };
  };
  message: string;
};

export async function getSeedanceTask(args: { taskId: string; apiKey: string }): Promise<GetSeedanceTaskResult> {
  const res = await piapiRequest<PiapiGetResponse>({
    method: 'GET',
    path: `/api/v1/task/${encodeURIComponent(args.taskId)}`,
    apiKey: args.apiKey,
    timeoutMs: 15_000,
  });
  const raw = (res?.data?.status ?? '').toLowerCase() as SeedanceTaskStatus;
  const status: SeedanceTaskStatus = ['pending', 'processing', 'completed', 'failed', 'staged'].includes(raw)
    ? raw
    : 'pending';
  return {
    status,
    videoUrl: res?.data?.output?.video,
    error: res?.data?.error?.message,
  };
}
