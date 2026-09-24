#!/usr/bin/env node
// Free-try funnel: how many tries, how many finished, how many turned into a
// sign-up (claimed). Read-only.   npm run try:stats [days=14]
import postgres from 'postgres';
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const days = Number(process.argv[2] ?? 14);
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const rows = await sql`
  select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, kind,
         count(*)::int as tries,
         count(*) filter (where status = 'ready')::int as ready,
         count(*) filter (where status = 'failed')::int as failed,
         count(distinct visitor)::int as visitors,
         count(*) filter (where claimed_by is not null)::int as claimed
  from try_generations
  where created_at > now() - make_interval(days => ${days})
  group by 1, 2 order by 1 desc, 2`;
console.table(rows.map((r) => ({ ...r, 'sign-up %': r.ready ? Math.round((100 * r.claimed) / r.ready) + '%' : '-' })));
await sql.end();
