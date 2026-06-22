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
import { resolveXQuery } from './resolve';
import {
  fetchGoogleNews,
  fetchGoogleNewsControversy,
  fetchHackerNews,
  fetchWikipedia,
  fetchRedditMentions,
  fetchXMentions,
  xReadsConfigured,
  type RawMention,
  type MentionSourceId,
} from './sources';

export interface ShieldScanOptions {
  userId: string;
  brand: string;
  /** Restrict the scan to these sources (e.g. ['x'] for X-only). When omitted,
   *  every available source runs. */
  sources?: MentionSourceId[];
}

export interface ShieldScanResult {
  total: number;
  newMentions: number;
  newActions: number;
  /** When X was scanned, the account the brand name resolved to (if any). */
  resolvedX?: { handle: string | null; displayName: string | null };
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

  // A source runs only if it's in opts.sources (or opts.sources is omitted).
  const want = (s: MentionSourceId) => !opts.sources || opts.sources.includes(s);

  const redditAccount = accountFor('reddit');
  const redditToken = redditAccount ? decryptToken(redditAccount.accessToken) : null;

  // Smart-resolve the brand to a real X account first, so we search mentions of
  // the actual handle (+ display name) even when the user typed the org's name.
  let resolvedX: ShieldScanResult['resolvedX'];
  let xQuery: string | undefined;
  if (want('x') && xReadsConfigured()) {
    const r = await resolveXQuery(brand);
    resolvedX = { handle: r.handle, displayName: r.displayName };
    xQuery = r.query;
  }

  // Build the task list from the requested sources. X reads run via
  // TwitterAPI.io (key-only); replies still need a connected account at approve.
  const tasks: Promise<RawMention[]>[] = [];
  if (want('google_news')) {
    tasks.push(fetchGoogleNews(brand), fetchGoogleNewsControversy(brand));
  }
  if (want('hackernews')) tasks.push(fetchHackerNews(brand));
  if (want('wikipedia')) tasks.push(fetchWikipedia(brand));
  if (want('reddit') && redditToken) tasks.push(fetchRedditMentions(brand, redditToken));
  if (want('x') && xReadsConfigured()) tasks.push(fetchXMentions(brand, { query: xQuery }));

  const settled = await Promise.allSettled(tasks);
  const all: RawMention[] = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []));

  // Deduplicate by external id within this batch
  const seen = new Set<string>();
  const deduped = all.filter(m => {
    const key = m.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) return { total: 0, newMentions: 0, newActions: 0, resolvedX };

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
  if (novel.length === 0) return { total: deduped.length, newMentions: 0, newActions: 0, resolvedX };

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

  // Insert pending actions with empty script — user generates reply on demand
  // Pre-wire targetPlatform/targetPostId for X tweets so reply is one click
  let newActions = 0;
  if (actionable.length > 0) {
    await db().insert(shieldActions).values(
      actionable.map(row => {
        const raw = novel.find(m => m.id === row.externalId);
        const isX = raw?.source === 'x';
        return {
          mentionId: row.id,
          userId,
          status: 'pending' as const,
          script: '',
          targetPlatform: isX ? 'x' : null,
          targetPostId: isX ? (raw?.platformPostId ?? null) : null,
        };
      }),
    );
    newActions = actionable.length;
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

  return { total: deduped.length, newMentions: novel.length, newActions, resolvedX };
}
