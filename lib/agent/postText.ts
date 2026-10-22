import type { DraftVariant, Platform } from '../db/schema';

/** The fields postText reads. Pure (no db), so the review screen runs the exact same rule as the publisher. */
export type PostTextDraft = {
  body: string;
  perPlatformText: Partial<Record<string, string>> | null;
  variants: Pick<DraftVariant, 'text' | 'perPlatform'>[] | null;
};

/**
 * The text a draft posts to `p`. Autopilot writes per-platform copy next to the
 * body (and snapshots it on variant A). Once the user edits the body, that
 * machine copy is stale: the edited body goes out — unless the user rewrote
 * this platform's copy too. Hand-made drafts (no snapshot) keep the old rule:
 * per-platform text if set, else the body.
 */
export function postText(draft: PostTextDraft, p: Platform): string {
  const own = draft.perPlatformText?.[p];
  const machine = draft.variants?.[0]?.perPlatform;
  if (!machine || !own) return own ?? draft.body;
  const bodyEdited = draft.body !== draft.variants?.[0]?.text;
  return bodyEdited && own === machine[p] ? draft.body : own;
}
