/**
 * Starter topics offered in onboarding and on Autopilot. Ids are what's saved
 * in agent_settings.niches; lib/trends/sources.ts maps known ids to search
 * keywords (anything else is searched as typed).
 */
export const TOPICS: readonly { id: string; label: string }[] = [
  { id: 'food-drink', label: 'Food & drink' },
  { id: 'local-business', label: 'Local business' },
  { id: 'retail', label: 'Retail & e-commerce' },
  { id: 'health-fitness', label: 'Health & fitness' },
  { id: 'education', label: 'Education' },
  { id: 'travel', label: 'Travel' },
  { id: 'saas', label: 'Solo SaaS' },
  { id: 'ai', label: 'AI tooling' },
  { id: 'design', label: 'Design' },
  { id: 'marketing', label: 'Indie marketing' },
  { id: 'creator-economy', label: 'Creator economy' },
  { id: 'devtools', label: 'Dev tools' },
  { id: 'fintech', label: 'Fintech' },
  { id: 'media', label: 'Media' },
  { id: 'community', label: 'Community' },
];

export const topicLabel = (id: string) => TOPICS.find((t) => t.id === id)?.label ?? id.replace(/-/g, ' ');

/**
 * Typed text → a saved topic id, or an error to show. A topic is what trends
 * are searched for: a sentence or a URL only pulls in noise.
 */
export function parseTopic(raw: string): { id: string } | { error: string } | null {
  const id = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
  if (!id) return null;
  if (id.split('-').length > 4 || /[.,/]/.test(id)) return { error: 'Keep a topic short, like “filter coffee”. Your website has its own field.' };
  return { id };
}
