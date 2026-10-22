#!/usr/bin/env node
// One-off: switch every user on "Ask me first" (auto_publish_threshold > 100)
// to "Post automatically" (1 — every rated draft posts at its slot; see
// drizzle/0023). Users who already post automatically are left alone, and so
// are existing drafts: nothing is approved here, only drafts written from now
// on are scheduled on their own. Each switched user gets a bell notice saying
// how to switch back. Idempotent: a second run finds no one to change.
//
//   node scripts/auto-approve-everyone.mjs --dry-run   # count + user ids, writes nothing
//   node scripts/auto-approve-everyone.mjs             # apply
import postgres from 'postgres';
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const AUTO = 1;
const dry = process.argv.includes('--dry-run');
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

try {
  if (dry) {
    const rows = await sql`select user_id from agent_settings where auto_publish_threshold > 100 order by user_id`;
    const [{ n }] = await sql`select count(*)::int as n from agent_settings where auto_publish_threshold between 2 and 100`;
    console.log(`[dry-run] ${rows.length} user(s) on "Ask me first" would switch to "Post automatically":`);
    for (const r of rows) console.log(`  ${r.user_id}`);
    console.log(`[dry-run] left alone: ${n} user(s) already on auto with an older score bar (2-100).`);
  } else {
    const changed = await sql.begin(async (tx) => {
      const rows = await tx`
        update agent_settings set auto_publish_threshold = ${AUTO}, updated_at = now()
        where auto_publish_threshold > 100
        returning user_id`;
      for (const { user_id } of rows) {
        await tx`
          insert into activity_log (user_id, kind, title, body, meta)
          values (${user_id}, 'agent_enabled', 'Autopilot now posts automatically',
            'New posts go out at their planned time. You can still edit or skip them in This week until then, or switch back to "Ask me first" in Autopilot → Rules.',
            ${sql.json({ via: 'auto-approve-everyone' })})`;
      }
      return rows;
    });
    console.log(`Switched ${changed.length} user(s) to "Post automatically":`);
    for (const r of changed) console.log(`  ${r.user_id}`);
  }
} finally {
  await sql.end();
}
