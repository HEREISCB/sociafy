import crypto from 'crypto';

/**
 * AES-256-GCM token encryption for OAuth access/refresh tokens at rest.
 *
 * Format: "v1:" + base64url(iv ‖ ciphertext ‖ authTag)
 *   iv: 12 bytes (GCM standard)
 *   authTag: 16 bytes (GCM standard)
 *
 * Backward compat: rows written before this module existed are plaintext.
 * decryptToken() returns the input unchanged if it doesn't start with "v1:",
 * so reads keep working through the migration. Re-encrypted lazily on every
 * write via the helpers used in OAuth callback / token refresh / disconnect.
 */

const IS_PROD = process.env.NODE_ENV === 'production';

function deriveKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY || process.env.INTERNAL_API_SECRET;
  if (IS_PROD && (!raw || raw.length < 32)) {
    throw new Error(
      'TOKEN_ENC_KEY (or INTERNAL_API_SECRET as fallback) must be 32+ chars in production.',
    );
  }
  // SHA-256 of the secret gives us a deterministic 32-byte key without
  // requiring users to manage a hex/base64 32-byte string directly.
  return crypto.createHash('sha256').update(raw || 'dev-key-not-for-prod').digest();
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = deriveKey();
  return cachedKey;
}

const PREFIX = 'v1:';

export function encryptToken(plaintext: string): string {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, enc, tag]).toString('base64url');
}

export function decryptToken(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) {
    // Legacy plaintext row — return as-is. Will be re-encrypted on next write.
    return value;
  }
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (raw.length < 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    // Bad key, tampered ciphertext, or wrong format. Treat as missing.
    return null;
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
