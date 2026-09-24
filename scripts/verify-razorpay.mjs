#!/usr/bin/env node
// Verify the Razorpay env vars actually work before trusting a checkout.
// Checks: keys authenticate, the three plan IDs exist, and each plan's amount
// matches TIER_PRICING.INR in lib/billing/pricing.ts. Read-only — creates nothing.
//
//   npm run verify:razorpay
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// Mirrors TIER_PRICING.INR — paise. Keep in sync with lib/billing/pricing.ts.
const EXPECTED = {
  starter:  { env: 'RAZORPAY_PLAN_STARTER',  amount: 299900  },
  pro:      { env: 'RAZORPAY_PLAN_PRO',      amount: 799900  },
  business: { env: 'RAZORPAY_PLAN_BUSINESS', amount: 2999900 },
};

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

const missing = [
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  ...Object.values(EXPECTED).map((e) => e.env),
].filter((k) => !process.env[k]);

if (missing.length) {
  console.error(`✗ unset: ${missing.join(', ')}`);
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
const api = (path) =>
  fetch(`https://api.razorpay.com/v1${path}`, { headers: { Authorization: auth } });

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };

console.log(`mode: ${keyId.startsWith('rzp_live_') ? 'LIVE' : 'test'}  (${keyId})`);

// Auth probe. 401 here means the key pair is wrong; anything else means it works.
const probe = await api('/payments?count=1');
if (probe.status === 401) {
  fail('key_id / key_secret rejected (401) — regenerate or re-copy them');
  process.exit(1);
}
if (!probe.ok) fail(`unexpected ${probe.status} on auth probe: ${await probe.text()}`);
else console.log('✓ keys authenticate');

for (const [tier, { env: envName, amount }] of Object.entries(EXPECTED)) {
  const planId = process.env[envName];
  const res = await api(`/plans/${planId}`);
  if (!res.ok) {
    fail(`${tier}: ${envName}=${planId} → ${res.status} (wrong id, or a test id used with live keys)`);
    continue;
  }
  const plan = await res.json();
  const got = plan.item?.amount;
  const period = `${plan.interval ?? '?'} ${plan.period ?? '?'}`;
  if (got !== amount) {
    fail(`${tier}: plan charges ${got / 100} INR but pricing.ts advertises ${amount / 100} INR`);
  } else if (plan.period !== 'monthly') {
    fail(`${tier}: plan period is "${period}", expected monthly — grants are monthly`);
  } else {
    console.log(`✓ ${tier}: ₹${(got / 100).toLocaleString('en-IN')}/month  ${planId}`);
  }
}

const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
// Can't validate it remotely — Razorpay never reads it back. Length is the one
// thing checkable here, and a short secret weakens the HMAC that gates every grant.
if (secret.length < 16) fail(`RAZORPAY_WEBHOOK_SECRET is only ${secret.length} chars — use 32+`);
else console.log('✓ webhook secret present (verify by sending a test event from the dashboard)');

console.log(failed ? '\nFAILED — fix the above before taking payments.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
