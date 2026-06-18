/**
 * lib/shield/monitor.ts
 *
 * Orchestrates a full shield scan for one user.
 * 1. Loads connected accounts to get OAuth tokens for Reddit / X.
 * 2. Fetches all available sources in parallel.
 * 3. Scores sentiment with scoreMention().
 * 4. De-dupes against existing mentions rows by externalId.
 * 5. Inserts new negative/crisis mentions → inserts pending shieldActions.
 * 6. Logs to activityLog.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  connectedAccounts,
  activityLog,
  mentions,
  shieldActions,
  type Platform,
} from '../db/schema';
import { decryptToken } from '../crypto/tokens';
import { scoreMention } from './sentiment';
import { generateScript } from './script';
import {
  fetchAllFreeSources,
  fetchRedditMentions,
  fetchXMentions,
  type RawMention,
} from './sources';

export interface ShieldScanOptions {
  userId: string;
  brand: string;
}

export interface ShieldScanResult {
  total: number;
  newMentions: number;
  newActions: number;
}

export async function runShieldScan(opts: ShieldScanOptions): Promise<ShieldScanResult> {
  const { userId, brand } = opts;
  if (!brand || brand.length < 2) return { total: 0, newMentions: 0, newActions: 0 };

  // Load connected accounts for OAuth-authenticated sources
  const accounts = await db()
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.isStub, false)));

  const accountFor = (p: Platform) => accounts.find(a => a.platform === p);

  // Parallel fetch — authenticated sources used when available, else skipped
  const freeTask = fetchAllFreeSources(brand);

  const redditAccount = accountFor('reddit');
  const redditToken = redditAccount ? decryptToken(redditAccount.accessToken) : null;
  const redditTask = redditToken
    ? fetchRedditMentions(brand, redditToken)
    : Promise.resolve([] as RawMention[]);

  const xAccount = accountFor('x');
  const xToken = xAccount ? decryptToken(xAccount.accessToken) : null;
  const xTask = xToken
    ? fetchXMentions(brand, xToken)
    : Promise.resolve([] as RawMention[]);

  const [freeResult, redditResult, xResult] = await Promise.allSettled([freeTask, redditTask, xTask]);

  const all: RawMention[] = [
    ...(freeResult.status === 'fulfilled' ? freeResult.value : []),
    ...(redditResult.status === 'fulfilled' ? redditResult.value : []),
    ...(xResult.status === 'fulfilled' ? xResult.value : []),
  ];

  // Deduplicate by external id within this batch
  const seen = new Set<string>();
  const deduped = all.filter(m => {
    const key = m.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) return { total: 0, newMentions: 0, newActions: 0 };

  // Check which externalIds already exist in the DB for this user
  const existingIds = new Set(
    (
      await db()
        .select({ externalId: mentions.externalId })
        .from(mentions)
        .where(
          and(
            eq(mentions.userId, userId),
            inArray(
              mentions.externalId,
              deduped.map(m => m.id),
            ),
          ),
        )
    ).map(r => r.externalId),
  );

  const novel = deduped.filter(m => !existingIds.has(m.id));
  if (novel.length === 0) return { total: deduped.length, newMentions: 0, newActions: 0 };

  // Score all novel mentions
  const scored = novel.map(m => ({ m, sentiment: scoreMention(m.title, m.body) }));

  // Insert novel mentions
  await db().insert(mentions).values(
    scored.map(({ m, sentiment }) => ({
      userId,
      brand,
      source: m.source as any,
      externalId: m.id,
      url: m.url,
      title: m.title.slice(0, 500),
      body: m.body.slice(0, 500),
      author: m.author.slice(0, 200),
      engagement: m.engagement,
      sentimentLabel: sentiment.label,
      sentimentScore: sentiment.score,
      severity: sentiment.severity,
      theme: sentiment.theme,
      crisisWords: sentiment.crisisWords as any,
      negWords: sentiment.negWords as any,
    })),
  );

  // Fetch the just-inserted row ids we need for shieldActions
  const inserted = await db()
    .select({ id: mentions.id, externalId: mentions.externalId, title: mentions.title, theme: mentions.theme, sentimentLabel: mentions.sentimentLabel, severity: mentions.severity })
    .from(mentions)
    .where(
      and(
        eq(mentions.userId, userId),
        inArray(
          mentions.externalId,
          novel.map(m => m.id),
        ),
      ),
    );

  // Only create actions for crisis + negative
  const actionable = inserted.filter(
    r => r.sentimentLabel === 'crisis' || r.sentimentLabel === 'negative',
  );

  let newActions = 0;
  for (const row of actionable) {
    // Generate a response script — fire and don't block on individual failures
    let script = '';
    try {
      const novelMention = novel.find(m => m.id === row.externalId);
      const result = await generateScript({
        brand,
        allegation: `${row.title} ${novelMention?.body ?? ''}`.slice(0, 400),
        theme: row.theme,
        source: novelMention?.source ?? 'web',
        severity: row.severity,
      });
      script = result.script;
    } catch { /* use empty draft */ }

    await db().insert(shieldActions).values({
      mentionId: row.id,
      userId,
      status: 'pending',
      script,
      targetPlatform: null,
      targetPostId: null,
    });
    newActions++;
  }

  // Log to activityLog
  if (actionable.length > 0) {
    await db().insert(activityLog).values({
      userId,
      kind: 'shield_mention_detected',
      title: `Shield detected ${actionable.length} negative mention${actionable.length === 1 ? '' : 's'} for "${brand}"`,
      body: actionable.map(r => r.title).slice(0, 3).join(' · '),
      meta: { brand, count: actionable.length },
    });
  }

  return { total: deduped.length, newMentions: novel.length, newActions };
}
