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
 *   node scripts/cron-run.mjs reissue-invoices
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

/**
 * Fail here, with the file name, rather than six frames deep inside the postgres
 * driver as a bare "TypeError: Invalid URL".
 *
 * This bites specifically because there are two sources of truth: the web
 * process is started once and keeps its env in memory, so the app can be serving
 * happily while .env.local on disk holds a placeholder — and only cron, which
 * reads the file fresh every run, ever notices.
 */
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[cron] DATABASE_URL is not set. Looked in .env.local and .env under', root);
  process.exit(2);
}
try {
  new URL(dbUrl);
} catch {
  // Never print the value — it carries the password.
  const placeholder = /<[^>]+>|YOUR-PASSWORD|CHANGEME/i.test(dbUrl)
    ? ' It still contains a placeholder such as <REGION> or [YOUR-PASSWORD].'
    : '';
  console.error(`[cron] DATABASE_URL is not a valid URL.${placeholder} Check .env.local under ${root}`);
  process.exit(2);
}

/**
 * tsx MUST be preloaded by the node invocation — `node --import tsx <this>` —
 * so the .ts cron modules can be imported without a build step.
 *
 * Registering it from inside this file does not work on a current Node. The old
 * `register('tsx/esm')` routes through the --loader hook deprecated in 20.6 and
 * now fails outright ("tsx must be loaded with --import instead of --loader"),
 * and tsx's own register() installs the hook too late — the module graph is
 * already being built, so every import dies with ERR_REQUIRE_CYCLE_MODULE.
 * Either way all six tasks failed, not one.
 *
 * etc/cron.d/sociafy passes the flag. This check exists so a hand-run without it
 * prints the fix instead of a stack trace about missing exports.
 */
async function loadCronModule(specifier, exportName) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (e) {
    console.error(`[cron] cannot load ${specifier}: ${e?.message}`);
    console.error('[cron] run it as:  node --import tsx scripts/cron-run.mjs <task>');
    process.exit(2);
  }
  // Under --import tsx the .ts modules come back CJS-interop'd, so the named
  // export lives on `default` rather than on the namespace. Accept both so this
  // keeps working if that ever changes.
  const fn = mod[exportName] ?? mod.default?.[exportName];
  if (typeof fn !== 'function') {
    console.error(`[cron] ${specifier} has no export "${exportName}" (got: ${Object.keys(mod).join(', ')})`);
    console.error('[cron] run it as:  node --import tsx scripts/cron-run.mjs <task>');
    process.exit(2);
  }
  return fn;
}

const which = process.argv[2];
if (!which) {
  console.error(
    'Usage: node scripts/cron-run.mjs <publish|finalize-video-jobs|shield-monitor|trends|agent|refresh-tokens|reissue-invoices>',
  );
  process.exit(2);
}

const startedAt = new Date();
console.log(`[cron] ${which} starting at ${startedAt.toISOString()}`);

try {
  let payload;
  if (which === 'publish') {
    payload = await (await loadCronModule('../lib/cron/publish.ts', 'runPublish'))();
  } else if (which === 'finalize-video-jobs') {
    // Same module the HTTP route calls — sweeps stale video_jobs and stale
    // async image gen_jobs, failing and refunding what nothing else will close.
    payload = await (await loadCronModule('../lib/cron/finalizeJobs.ts', 'runFinalizeJobs'))();
  } else if (which === 'shield-monitor') {
    payload = await (await loadCronModule('../lib/cron/shieldMonitor.ts', 'runShieldMonitor'))();
  } else if (which === 'trends') {
    payload = { users: await (await loadCronModule('../lib/cron/trends.ts', 'runTrends'))() };
  } else if (which === 'agent') {
    payload = { users: await (await loadCronModule('../lib/agent/run.ts', 'runAgentForAll'))() };
  } else if (which === 'refresh-tokens') {
    payload = await (await loadCronModule('../lib/cron/refreshTokens.ts', 'runRefreshTokens'))();
  } else if (which === 'reissue-invoices') {
    // Retries GST invoices a Zoho outage (or a missing ZOHO_* var) left as
    // 'failed'. Nothing else ever re-raises them.
    payload = await (await loadCronModule('../lib/billing/zoho/invoice.ts', 'reissueFailedInvoices'))();
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
