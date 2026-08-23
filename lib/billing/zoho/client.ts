/**
 * Zoho Books REST client — OAuth token handling and one `zoho()` call helper.
 *
 * Auth is the self-client refresh-token grant. The refresh token does not
 * expire, the access token lasts an hour; we cache it in module memory and
 * refresh 60s early. Nothing is persisted, so a process restart just costs one
 * extra token call.
 *
 * Zoho signals errors two ways and both have to be checked: a non-2xx HTTP
 * status, and a 200 body carrying a non-zero `code`. Treating only the former
 * as failure is how you end up storing `undefined` as an invoice number.
 */

import { env } from '../../env';

const accountsBase = () => `https://accounts.zoho.${env.zoho.region}/oauth/v2/token`;
const apiBase = () => `https://www.zohoapis.${env.zoho.region}/books/v3`;

export class ZohoError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.code = code;
  }
}

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

/** Access token, refreshed on demand. Concurrent callers share one refresh. */
export async function zohoAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  // Coalesce: a webhook burst would otherwise fire N identical refreshes and
  // Zoho rate-limits token requests hard (default 20 per 10 minutes).
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const body = new URLSearchParams({
      refresh_token: env.zoho.refreshToken!,
      client_id: env.zoho.clientId!,
      client_secret: env.zoho.clientSecret!,
      grant_type: 'refresh_token',
    });
    const res = await fetch(accountsBase(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new ZohoError(`token refresh failed: ${json.error ?? res.statusText}`, res.status);
    }
    cached = {
      token: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return cached.token;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

/** Drop the cached token. Called when Zoho answers 401 so the retry re-auths. */
export function resetZohoToken(): void {
  cached = null;
}

type ZohoBody = Record<string, unknown>;

/**
 * One Books API call. `organization_id` is appended for you — omitting it is
 * the single most common cause of a bewildering "resource not found".
 *
 * Retries once on 401 (token revoked/rotated out from under the cache).
 */
export async function zoho<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: ZohoBody; query?: Record<string, string> } = {},
): Promise<T> {
  const call = async (): Promise<Response> => {
    const url = new URL(`${apiBase()}${path}`);
    url.searchParams.set('organization_id', env.zoho.organizationId!);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

    return fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Zoho-oauthtoken ${await zohoAccessToken()}`,
        'content-type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  };

  let res = await call();
  if (res.status === 401) {
    resetZohoToken();
    res = await call();
  }

  const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string } & T;
  // Books returns code 0 on success. Anything else is an error even on a 200.
  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new ZohoError(
      `${init.method ?? 'GET'} ${path} → ${json.message ?? res.statusText}`,
      res.status,
      json.code,
    );
  }
  return json;
}
