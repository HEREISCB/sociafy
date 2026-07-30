#!/usr/bin/env node
/**
 * Mint a developer API key from the command line.
 *
 * Exists because the dashboard panel (/usage#api-keys) needs a reachable
 * database, and there are two situations where you still want a key: the app
 * can't see Postgres yet, or you want a cap the UI won't offer.
 *
 * The key format and hashing MUST stay identical to lib/api-key.ts — same
 * "sfy_live_" prefix, same 32 random bytes, same SHA-256 hex, same stored
 * prefix length. If you change one, change both or auth silently stops matching.
 *
 * Usage:
 *   node scripts/create-api-key.mjs --list
 *   node scripts/create-api-key.mjs --email you@example.com --name "local test"
 *   node scripts/create-api-key.mjs --user user_2abc... --cap 0 --credits 100000
 *   node scripts/create-api-key.mjs --user user_2abc... --sql     # print SQL, don't connect
 *
 * Flags:
 *   --list              show profiles (id, email) and exit
 *   --user <clerkId>    target profile id
 *   --email <addr>      target profile by email instead
 *   --name <label>      key label shown in the dashboard (default "cli")
 *   --cap <n>           per-key 24h credit cap; 0 or "none" = effectively unlimited
 *   --credits <n>       also grant this many credits (a key with a 0 balance 402s)
 *   --sql               print the SQL instead of executing it (for a DB console)
 */
import crypto from 'node:crypto';

// Node >= 21.7. Absent file is fine — DATABASE_URL may come from the real env.
try { process.loadEnvFile('.env.local'); } catch { /* not present */ }

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

// int4 max is 2147483647; stay clear of it so nothing overflows on arithmetic.
const UNLIMITED = 2_000_000_000;
const PREFIX = 'sfy_live_';
const PREFIX_LEN = PREFIX.length + 6;

const rawCap = String(flag('cap', '2000'));
const cap = rawCap === '0' || rawCap === 'none' ? UNLIMITED : Number(rawCap);
if (!Number.isInteger(cap) || cap <= 0) {
  console.error(`--cap must be a positive integer, 0, or "none" (got "${rawCap}")`);
  process.exit(1);
}
const credits = Number(flag('credits', '0'));
if (!Number.isInteger(credits) || credits < 0) {
  console.error('--credits must be a non-negative integer');
  process.exit(1);
}

const full = PREFIX + crypto.randomBytes(32).toString('base64url');
const keyHash = crypto.createHash('sha256').update(full).digest('hex');
const prefix = full.slice(0, PREFIX_LEN);
const name = String(flag('name', 'cli'));
// Unique per run so the credit_ledger partial unique index on meta->>'source'
// doesn't reject a second grant.
const grantSource = `admin_grant:cli:${Date.now()}`;

const sqlFor = (userId) => {
  const lines = [
    `INSERT INTO public.api_keys (user_id, name, prefix, key_hash, daily_credit_cap)`,
    `VALUES ('${userId}', '${name.replace(/'/g, "''")}', '${prefix}', '${keyHash}', ${cap});`,
  ];
  if (credits > 0) {
    lines.push(
      ``,
      `INSERT INTO public.credit_ledger (user_id, kind, credits, meta)`,
      `VALUES ('${userId}', 'admin_grant', ${credits}, '${JSON.stringify({ source: grantSource, note: 'created by scripts/create-api-key.mjs' })}'::jsonb);`,
    );
  }
  return lines.join('\n');
};

const printKey = (userId) => {
  console.log('\n  API key (shown once — it is SHA-256 hashed at rest and unrecoverable):\n');
  console.log(`    ${full}\n`);
  console.log(`  user      ${userId}`);
  console.log(`  name      ${name}`);
  console.log(`  prefix    ${prefix}`);
  console.log(`  cap       ${cap === UNLIMITED ? `${UNLIMITED} (effectively unlimited)` : cap} credits / 24h`);
  if (credits > 0) console.log(`  granted   ${credits} credits`);
  console.log(`\n  Test it:\n    curl -H "Authorization: Bearer ${full}" \\\n      "${process.env.NEXT_PUBLIC_APP_URL || 'https://sociafy.app'}/api/v1/me"\n`);
  if (cap === UNLIMITED) {
    console.log('  NOTE: API_DAILY_CREDIT_CAP still caps ALL keys combined (default 50000/24h).');
    console.log('        Raise it in the deployment env for a truly uncapped key.\n');
  }
};

const userArg = flag('user');
const emailArg = flag('email');

if (has('sql')) {
  if (!userArg) {
    console.error('--sql needs --user <clerkId> (it cannot look up an email without connecting)');
    process.exit(1);
  }
  console.log(sqlFor(String(userArg)));
  printKey(String(userArg));
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (checked the environment and .env.local).');
  console.error('Either set it, or use --user <clerkId> --sql to print SQL for a DB console.');
  process.exit(1);
}

const { default: postgres } = await import('postgres');
const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 15, onnotice: () => {} });

try {
  if (has('list') || (!userArg && !emailArg)) {
    const rows = await sql`SELECT id, email, tier FROM profiles ORDER BY created_at LIMIT 50`;
    if (rows.length === 0) {
      console.log('No profiles yet — sign in to the app once so a profile row is created.');
    } else {
      console.log('\n  profiles:\n');
      for (const r of rows) console.log(`    ${r.id}   ${r.email ?? '(no email)'}   ${r.tier}`);
      console.log('\n  Re-run with --user <id> (or --email <addr>) to mint a key.\n');
    }
    process.exit(0);
  }

  let userId = userArg ? String(userArg) : null;
  if (!userId) {
    const [row] = await sql`SELECT id FROM profiles WHERE lower(email) = ${String(emailArg).toLowerCase()} LIMIT 1`;
    if (!row) {
      console.error(`No profile with email "${emailArg}". Run with --list to see them.`);
      process.exit(1);
    }
    userId = row.id;
  } else {
    const [row] = await sql`SELECT id FROM profiles WHERE id = ${userId} LIMIT 1`;
    if (!row) {
      // Fail rather than insert an orphan key: api_keys.user_id has no FK, so a
      // typo would create a key that authenticates as a nonexistent profile.
      console.error(`No profile with id "${userId}". Run with --list to see them.`);
      process.exit(1);
    }
  }

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO api_keys (user_id, name, prefix, key_hash, daily_credit_cap)
      VALUES (${userId}, ${name}, ${prefix}, ${keyHash}, ${cap})
    `;
    if (credits > 0) {
      await tx`
        INSERT INTO credit_ledger (user_id, kind, credits, meta)
        VALUES (${userId}, 'admin_grant', ${credits}, ${sql.json({ source: grantSource, note: 'scripts/create-api-key.mjs' })})
      `;
    }
  });

  const [{ balance }] = await sql`
    SELECT COALESCE(SUM(credits), 0)::int AS balance FROM credit_ledger WHERE user_id = ${userId}
  `;
  printKey(userId);
  console.log(`  balance   ${balance} credits\n`);
} catch (e) {
  console.error('\nFailed:', e?.message || e);
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminating|SASL|password/i.test(String(e?.message))) {
    console.error('Looks like the database is unreachable — the same failure the dashboard');
    console.error('panel is hitting. Fix connectivity, or use --user <id> --sql instead.\n');
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
