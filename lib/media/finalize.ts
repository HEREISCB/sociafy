import * as https from 'node:https';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../storage/r2';

/**
 * Shared media finalize helpers — download a provider artifact and push it to
 * R2. Used by the Seedance poller (downloads from PiAPI's CDN) and available to
 * any future provider whose output we don't already control.
 *
 * Modal jobs do NOT use storeFromUrl: the Modal GPU function uploads straight to
 * R2 and returns the public URL, so those pollers just record the asset.
 *
 * TLS hardened (TLS 1.2 + http/1.1 + IPv4) — same posture as our other outbound
 * HTTPS so the AV / proxy class of failures can't bite during the download.
 */

const dlAgent = new https.Agent({
  keepAlive: false,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
  family: 4,
});

export function downloadToBuffer(
  rawUrl: string,
  redirectsLeft = 5,
): Promise<{ buffer: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { 'User-Agent': 'sociafy/1.0', Accept: '*/*' },
        agent: dlAgent,
      },
      (res) => {
        // Follow redirects (provider CDNs often 302)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too_many_redirects'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          downloadToBuffer(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`download_${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
        res.on('error', reject);
      },
    );
    req.setTimeout(60_000, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.end();
  });
}

/** Download a provider URL and push it to R2; returns the stored object's metadata. */
export async function storeFromUrl(args: {
  userId: string;
  url: string;
  ext: string;
  fallbackMime: string;
}): Promise<{ key: string; publicUrl: string; mimeType: string; sizeBytes: number }> {
  const dl = await downloadToBuffer(args.url);
  const mimeType = dl.contentType || args.fallbackMime;
  const key = makeMediaKey(
    args.userId,
    `${args.ext}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${args.ext}`,
  );
  await uploadBuffer({ key, body: dl.buffer, contentType: mimeType });
  return { key, publicUrl: publicUrlFor(key), mimeType, sizeBytes: dl.buffer.length };
}
