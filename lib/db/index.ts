import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { env } from '../env';

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Resolve the postgres pool size. For a long-running private-server
 * deployment we want more connections than the old serverless default of 5
 * (since a single Node process serves many concurrent requests). Override
 * with DB_POOL_MAX when load patterns differ.
 *
 * Default: 5 in serverless (Vercel sets VERCEL=1), 20 otherwise.
 */
function resolvePoolMax(): number {
  const explicit = Number(process.env.DB_POOL_MAX);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return process.env.VERCEL ? 5 : 20;
}

/**
 * Warn (don't fail) if DATABASE_URL doesn't look like a pooler endpoint in
 * production. Direct-connect URLs work but can exhaust the cluster's
 * connection limit under load; the pooler endpoint multiplexes safely.
 */
function warnIfDirectConnect(url: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  const looksLikePooler =
    /pooler\.supabase\.com/i.test(url) ||
    /pgbouncer/i.test(url) ||
    /transaction-pool/i.test(url);
  if (!looksLikePooler) {
    console.warn(
      '[db] DATABASE_URL does not look like a connection-pooler endpoint. ' +
        'Under load this can exhaust the Postgres cluster\'s max_connections. ' +
        'Prefer the Supabase transaction pooler URL (or pgbouncer in front).',
    );
  }
}

export const db = () => {
  if (_db) return _db;
  if (!env.database.url) {
    throw new Error('DATABASE_URL is not set. The DB layer is unavailable until configured.');
  }
  warnIfDirectConnect(env.database.url);
  const client = postgres(env.database.url, {
    prepare: false,
    max: resolvePoolMax(),
  });
  _db = drizzle(client, { schema });
  return _db;
};

export { schema };
export type DB = ReturnType<typeof db>;
