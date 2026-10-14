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
      ? 'Refund — unused web searches'
      : row.meta?.partialOf || reason.startsWith('partial_failure')
        ? 'Refund — some results failed'
        : 'Refund — generation failed';
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
