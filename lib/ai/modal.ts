import * as https from 'node:https';

/**
 * Modal GPU engine client — Voice Twin (clone TTS) + Avatar (talking video).
 *
 * Same TLS-hardened posture as piapi.ts (TLS 1.2 + http/1.1 + IPv4) so the
 * Windows-AV / TLS-1.3 class of handshake failures can't bite. Every request
 * carries `X-Engine-Secret` so only our app can invoke the engines.
 *
 * The underlying model names never appear here — engines are addressed purely
 * by role ('voice' | 'avatar') and the configured base URLs.
 *
 * Long jobs use Modal's spawn → poll shape: `*Submit` returns a `callId`, and
 * `get*Result` reports `pending | done | failed`. TTS usually resolves in 1–2
 * polls; avatar takes minutes.
 */

const sharedAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
  family: 4,
});

export type Engine = 'voice' | 'avatar';

function baseUrl(engine: Engine): string | undefined {
  return engine === 'voice'
    ? process.env.MODAL_VOICE_ENGINE_URL
    : process.env.MODAL_AVATAR_ENGINE_URL;
}

/** True when this engine's base URL + the shared secret are both configured.
 *  Callers use this to fall back to stub mode when false. */
export function modalConfigured(engine: Engine): boolean {
  return Boolean(baseUrl(engine) && process.env.MODAL_WEBHOOK_SECRET);
}

function call<T>(
  engine: Engine,
  opts: { method: 'GET' | 'POST'; pathSuffix: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const root = baseUrl(engine);
  const secret = process.env.MODAL_WEBHOOK_SECRET;
  if (!root || !secret) return Promise.reject(new Error('modal_not_configured'));
  const url = new URL(opts.pathSuffix, root.endsWith('/') ? root : root + '/');
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'X-Engine-Secret': secret,
      Accept: 'application/json',
      'User-Agent': 'sociafy/1.0',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
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
            reject(new Error(`modal_${res.statusCode}: ${text.slice(0, 400)}`));
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

// ---- Voice engine ----

export type PrepareVoiceResult = {
  ok: boolean;
  durationS?: number;
  transcript?: string;
  language?: string;
  error?: string;
};

/** Validate + transcribe a reference clip (synchronous; a few seconds). */
export function prepareVoice(args: { refAudioUrl: string }): Promise<PrepareVoiceResult> {
  return call('voice', { method: 'POST', pathSuffix: 'voice/prepare', body: args, timeoutMs: 60_000 });
}

export function submitTts(args: {
  refAudioUrl: string;
  refText: string;
  text: string;
}): Promise<{ callId: string }> {
  return call('voice', { method: 'POST', pathSuffix: 'tts/submit', body: args });
}

export type TtsResult = { status: 'pending' | 'done' | 'failed'; audioUrl?: string; error?: string };

export function getTtsResult(callId: string): Promise<TtsResult> {
  return call('voice', {
    method: 'GET',
    pathSuffix: `tts/result?callId=${encodeURIComponent(callId)}`,
    timeoutMs: 15_000,
  });
}

// ---- Avatar engine ----

export type SubmitAvatarArgs = {
  imageUrl: string;
  prompt?: string;
  aspect: string;
  quality: '480p' | '720p';
  expressive?: boolean;
  /** Either supply a voice reference + script (engine synthesizes speech)… */
  voice?: { refAudioUrl: string; refText: string };
  script?: string;
  /** …or supply a ready audio track to drive the avatar directly. */
  audioUrl?: string;
};

export function submitAvatar(args: SubmitAvatarArgs): Promise<{ callId: string }> {
  return call('avatar', { method: 'POST', pathSuffix: 'avatar/submit', body: args });
}

export type AvatarResult = { status: 'pending' | 'done' | 'failed'; videoUrl?: string; error?: string };

export function getAvatarResult(callId: string): Promise<AvatarResult> {
  return call('avatar', {
    method: 'GET',
    pathSuffix: `avatar/result?callId=${encodeURIComponent(callId)}`,
    timeoutMs: 15_000,
  });
}
