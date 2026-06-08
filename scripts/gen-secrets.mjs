#!/usr/bin/env node
/**
 * Generate the random secrets the app needs at boot.
 *
 *   INTERNAL_API_SECRET   — signs OAuth state cookies + falls back to TOKEN_ENC_KEY
 *   CRON_SECRET           — Bearer token for cron HTTP endpoints (only needed if you
 *                           ever curl them; the CLI runners don't read it)
 *   TOKEN_ENC_KEY         — derives the AES-256-GCM key for OAuth tokens at rest
 *
 * Usage:
 *   node scripts/gen-secrets.mjs
 *
 * Copy the output into .env.local (or your secret manager). Re-running this
 * generates new values — rotating TOKEN_ENC_KEY will invalidate already-stored
 * tokens, so don't rotate without a migration plan.
 */
import { randomBytes } from 'node:crypto';

const fmt = (label, bytes = 48) => {
  const v = randomBytes(bytes).toString('base64url').slice(0, 48);
  return `${label}=${v}`;
};

console.log('# Add these to .env.local on the production host:');
console.log(fmt('INTERNAL_API_SECRET'));
console.log(fmt('CRON_SECRET'));
console.log(fmt('TOKEN_ENC_KEY'));
