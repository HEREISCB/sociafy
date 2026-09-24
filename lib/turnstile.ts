/**
 * Cloudflare Turnstile bot check for the public free tools. Off until both
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set, so the
 * tools keep working before the keys exist.
 */
export const turnstileEnabled = () => !!(process.env.TURNSTILE_SECRET_KEY && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

/** True when the token is valid, or when Turnstile isn't configured. */
export async function verifyTurnstile(token: string | undefined | null, ip: string): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY!, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch (e) {
    // Cloudflare unreachable: fail open. The per-visitor and site-wide daily caps still hold.
    console.warn('[turnstile] verify failed, allowing', (e as Error).message);
    return true;
  }
}
