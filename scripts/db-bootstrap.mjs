#!/usr/bin/env node
// Apply drizzle/0000_init.sql to the database. Idempotent.
// Loads DATABASE_URL from .env.local if needed.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadEnv(file) {
  const path = resolve(root, file);
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv('.env.local');
loadEnv('.env');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set. Add it to .env.local first.');
  process.exit(1);
}

const sqlPath = resolve(root, 'drizzle/0000_init.sql');
if (!existsSync(sqlPath)) {
  console.error(`Missing ${sqlPath}`);
  process.exit(1);
}

const sql = readFileSync(sqlPath, 'utf8');
console.log(`Connecting to Postgres…`);
const client = postgres(url, { prepare: false, max: 1 });

try {
  console.log(`Applying ${sqlPath}…`);
  await client.unsafe(sql);
  console.log('Schema applied successfully.');

  console.log('\nTables in public schema:');
  const tables = await client`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `;
  for (const t of tables) console.log(`  • ${t.table_name}`);
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
