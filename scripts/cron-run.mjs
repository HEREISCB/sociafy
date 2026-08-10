#!/usr/bin/env node
/**
 * Shared cron entrypoint. Used by the systemd / crontab wrappers under
 * scripts/cron-*.mjs. Loads .env.local then dispatches by argv[2].
 *
 * Usage:
 *   node scripts/cron-run.mjs publish
 *   node scripts/cron-run.mjs finalize-video-jobs
 *   node scripts/cron-run.mjs shield-monitor
 *   node scripts/cron-run.mjs trends
 *   node scripts/cron-run.mjs agent
 *   node scripts/cron-run.mjs refresh-tokens
 *
 * Why direct invocation instead of curl-ing the route:
 *   - No HTTP round-trip / parse-serialize overhead
 *   - No dependency on the web process being healthy
 *   - No need to share CRON_SECRET with the cron user
 *   - Logs flow straight to stdout/stderr (journalctl / cron mail)
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

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

// Load tsx so we can import the .ts cron modules directly without a build step.
// The cron modules are short and don't pull in client-only deps.
try {
  register('tsx/esm', import.meta.url);
} catch (e) {
  console.error('[cron] failed to register tsx/esm — install tsx as a devDependency:', e?.message);
  process.exit(2);
}

const which = process.argv[2];
if (!which) {
  console.error(
    'Usage: node scripts/cron-run.mjs <publish|finalize-video-jobs|shield-monitor|trends|agent|refresh-tokens>',
  );
  process.exit(2);
}

const startedAt = new Date();
console.log(`[cron] ${which} starting at ${startedAt.toISOString()}`);

try {
  let payload;
  if (which === 'publish') {
    const { runPublish } = await import('../lib/cron/publish.ts');
    payload = await runPublish();
  } else if (which === 'finalize-video-jobs') {
    // Same module the HTTP route calls — sweeps stale video_jobs and stale
    // async image gen_jobs, failing and refunding what nothing else will close.
    const { runFinalizeJobs } = await import('../lib/cron/finalizeJobs.ts');
    payload = await runFinalizeJobs();
  } else if (which === 'shield-monitor') {
    const { runShieldMonitor } = await import('../lib/cron/shieldMonitor.ts');
    payload = await runShieldMonitor();
  } else if (which === 'trends') {
    const { runTrends } = await import('../lib/cron/trends.ts');
    payload = { users: await runTrends() };
  } else if (which === 'agent') {
    const { runAgentForAll } = await import('../lib/agent/run.ts');
    payload = { users: await runAgentForAll() };
  } else if (which === 'refresh-tokens') {
    const { runRefreshTokens } = await import('../lib/cron/refreshTokens.ts');
    payload = await runRefreshTokens();
  } else {
    console.error(`[cron] unknown task: ${which}`);
    process.exit(2);
  }
  const ms = Date.now() - startedAt.getTime();
  console.log(`[cron] ${which} done in ${ms}ms`);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
} catch (e) {
  console.error(`[cron] ${which} FAILED:`, e?.stack ?? e?.message ?? e);
  process.exit(1);
}
