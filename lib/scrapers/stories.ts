/* Live Instagram Stories volume via Apify's datavoyantlab/advanced-instagram-stories-scraper.
   One batched run covers every tracked handle (actor takes up to 100 usernames per
   call) — each dataset item is a single active story, so storiesCount per handle
   is just how many items came back for it. Non-fatal on failure: competitor refresh
   still succeeds with post/follower data, stories just stay untracked for that run. */
import { runActor } from './apify-client';

const STORIES_ACTOR = 'datavoyantlab~advanced-instagram-stories-scraper';
const MAX_USERNAMES_PER_RUN = 100;

type IgStoryItem = { username?: string; error?: string };

/** This actor 200s even when it can't run — a plan-gate rejection comes back
    as a single dataset item shaped `{ error: "...paying users..." }` rather
    than an HTTP error. Treat that as a hard failure, not "0 stories for
    everyone": callers must not silently record a fake zero. */
function isPlanGateRejection(items: IgStoryItem[]): boolean {
  return items.length > 0 && items.every((it) => typeof it.error === 'string' && !it.username);
}

/** Returns a map of handle (lowercase, no @) -> active story count. Handles with
    zero current stories are simply absent from the returned dataset, not zero-filled
    here — callers decide what "0 vs untracked" means for handles missing from the map.
    Throws if the actor rejected the run (e.g. free-plan gate) so callers can mark
    stories as untracked (null) instead of recording a false zero. */
export async function scrapeStoryCounts(handles: string[]): Promise<Map<string, number>> {
  const usernames = [...new Set(handles.map((h) => h.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
    .slice(0, MAX_USERNAMES_PER_RUN);
  const counts = new Map<string, number>();
  if (usernames.length === 0) return counts;

  const items = await runActor<IgStoryItem>(STORIES_ACTOR, { usernames });
  if (isPlanGateRejection(items)) {
    throw new Error(`stories actor unavailable: ${items[0].error}`);
  }
  for (const item of items) {
    const u = item.username?.trim().toLowerCase();
    if (!u) continue;
    counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return counts;
}
