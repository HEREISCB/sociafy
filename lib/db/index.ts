import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { env } from '../env';

let _db: ReturnType<typeof drizzle> | null = null;

export const db = () => {
  if (_db) return _db;
  if (!env.database.url) {
    throw new Error('DATABASE_URL is not set. The DB layer is unavailable until configured.');
  }
  const client = postgres(env.database.url, {
    prepare: false,
    max: 5,
  });
  _db = drizzle(client, { schema });
  return _db;
};

export { schema };
export type DB = ReturnType<typeof db>;
