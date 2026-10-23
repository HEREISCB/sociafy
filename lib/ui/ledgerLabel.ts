/**
 * Human labels for credit-ledger rows. The ledger stores internal codes
 * (action keys, refund reasons like `upstream_error`, draft/task ids); the
 * Billing & usage page shows only what a person would say.
 */
export type LedgerRowLike = {
  kind: string;
  action: string | null;
  /** Server label (ACTION_LABELS or the kind label), e.g. "Video · 8s · 720p · Quality". */
  label: string;
  meta: Record<string, unknown> | null;
};

/** What was made, in one word or two. Null when the action is unknown. */
export function ledgerCategory(action: string | null): string | null {
  if (!action) return null;
  if (action.startsWith('avatar_video')) return 'Avatar video';
  if (action.startsWith('video_motion')) return 'Motion graphic';
  if (action.startsWith('video_')) return 'Video';
  if (action.startsWith('image_')) return 'Image';
  if (action.startsWith('text_post') || action === 'agent_draft' || action === 'variant_regenerate') return 'Caption';
  const other: Record<string, string> = {
    web_search_extra: 'Web search',
    tts_synthesis: 'Voiceover',
    voice_twin_create: 'Voice clone',
    publish_x: 'Post to X',
    text_chat: 'API chat',
  };
  return other[action] ?? null;
}

const GRANT_TITLE: Record<string, string> = {
  signup_bonus: 'Welcome bonus',
  monthly_grant: 'Monthly credits',
  topup: 'Top-up',
  admin_grant: 'Credits from Sociafy',
};

const GRANT_DETAIL: Record<string, string> = {
  first_purchase: 'Subscription started',
  monthly_renewal: 'Renewal',
  upgrade_delta: 'Plan upgrade',
};

export function ledgerRowLabel(row: LedgerRowLike): { title: string; detail: string | null } {
  const reason = typeof row.meta?.reason === 'string' ? row.meta.reason : '';
  const category = ledgerCategory(row.action);

  if (row.kind === 'refund') {
    const title = reason.startsWith('reconcile')
      ? 'Refund: unused web searches'
      : row.meta?.partialOf || reason.startsWith('partial_failure')
        ? 'Refund: some results failed'
        : 'Refund: generation failed';
    return { title, detail: category };
  }

  if (row.kind === 'charge') {
    // "Video · 8s · 720p · Quality" → "8s · 720p · Quality"; bare labels add nothing.
    const parts = row.label.split(' · ');
    const detail = row.action === 'agent_draft' ? 'Autopilot'
      : row.action === 'text_post_research' ? 'With web research'
      : parts.length > 1 ? parts.slice(1).join(' · ')
      : null;
    return { title: category ?? row.label, detail };
  }

  return { title: GRANT_TITLE[row.kind] ?? row.label, detail: GRANT_DETAIL[reason] ?? null };
}

export type LedgerTone = 'spent' | 'added' | 'refund';

export function ledgerTone(kind: string, credits: number): LedgerTone {
  if (kind === 'refund') return 'refund';
  return credits < 0 ? 'spent' : 'added';
}

export type LedgerEntry = LedgerRowLike & { id: string; credits: number; createdAt: string };
export type LedgerLine = { id: string; title: string; detail: string | null; count: number; credits: number; tone: LedgerTone };
export type LedgerDay = { day: string; net: number; lines: LedgerLine[] };

/**
 * Newest-first ledger rows → one block per local day with that day's net, and
 * back-to-back rows that say the same thing collapsed into one line
 * ("Caption ×6 · Autopilot · −24"). Only adjacent rows merge, so the order of
 * what happened is never rewritten.
 */
export function groupLedger(rows: LedgerEntry[]): LedgerDay[] {
  const days: LedgerDay[] = [];
  for (const row of rows) {
    const day = new Date(row.createdAt).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    let block = days[days.length - 1];
    if (!block || block.day !== day) days.push((block = { day, net: 0, lines: [] }));
    block.net += row.credits;
    const { title, detail } = ledgerRowLabel(row);
    const tone = ledgerTone(row.kind, row.credits);
    const last = block.lines[block.lines.length - 1];
    if (last && last.title === title && last.detail === detail && last.tone === tone) {
      last.count += 1;
      last.credits += row.credits;
    } else {
      block.lines.push({ id: row.id, title, detail, count: 1, credits: row.credits, tone });
    }
  }
  return days;
}

export type CycleSummary = {
  carriedOver: number;
  added: number;
  spent: number;
  refunded: number;
  /** Gross spend per category, largest first. */
  byCategory: Array<{ category: string; credits: number }>;
};

/**
 * The cycle's arithmetic: carriedOver + added − spent + refunded = balance.
 * `rows` may be raw ledger rows or per-(kind, action) sums since the cycle
 * start; carriedOver is whatever the balance needs to make the sum true.
 */
export function summarizeCycle(
  rows: Array<{ kind: string; action: string | null; credits: number }>,
  balance: number,
): CycleSummary {
  let added = 0, spent = 0, refunded = 0;
  const cats = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === 'refund') refunded += r.credits;
    else if (r.credits < 0) {
      spent -= r.credits;
      const c = ledgerCategory(r.action) ?? 'Other';
      cats.set(c, (cats.get(c) ?? 0) - r.credits);
    } else added += r.credits;
  }
  return {
    carriedOver: balance - (added - spent + refunded),
    added,
    spent,
    refunded,
    byCategory: [...cats].map(([category, credits]) => ({ category, credits })).sort((a, b) => b.credits - a.credits),
  };
}
