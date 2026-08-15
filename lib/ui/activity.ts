/**
 * Activity-feed chip labels, shared by the dashboard feed and the agent feed.
 *
 * These two screens each had their own map and disagreed about the same event
 * ("Published" vs "Posted", "Agent off" vs "Paused"), and NEITHER had a case
 * for `platform_refresh_failed` — the one event that tells a user their
 * connection is dead. It rendered as the raw machine string, styled as routine.
 */

export type ActivityTone = 'accent' | 'warn' | '';

const META: Record<string, { label: string; tone: ActivityTone }> = {
  platform_connected: { label: 'Connected', tone: 'accent' },
  platform_disconnected: { label: 'Disconnected', tone: '' },
  platform_refresh_failed: { label: 'Reconnect needed', tone: 'warn' },
  draft_created: { label: 'Draft', tone: '' },
  draft_scheduled: { label: 'Scheduled', tone: '' },
  manual_publish: { label: 'Published', tone: 'accent' },
  auto_publish: { label: 'Auto-scheduled', tone: 'accent' },
  publish_failed: { label: 'Failed', tone: 'warn' },
  agent_drafted: { label: 'Agent draft', tone: '' },
  agent_held: { label: 'Held', tone: 'warn' },
  agent_skipped: { label: 'Skipped', tone: 'warn' },
  agent_enabled: { label: 'Agent on', tone: '' },
  agent_disabled: { label: 'Agent off', tone: '' },
  trend_spotted: { label: 'Trend', tone: 'accent' },
  onboarded: { label: 'Onboarded', tone: '' },
  shield_mention_detected: { label: 'Mention', tone: '' },
  shield_response_approved: { label: 'Reply approved', tone: '' },
  shield_response_published: { label: 'Reply posted', tone: 'accent' },
  shield_response_rejected: { label: 'Reply rejected', tone: 'warn' },
};

/** Never dump a raw `snake_case` kind at a user — humanise the unknown ones. */
export function activityMeta(kind: string): { label: string; tone: ActivityTone } {
  return META[kind] ?? { label: kind.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), tone: '' };
}
