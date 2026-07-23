/* Port of TACCV/core/ai_summary.py. Groq via the shared LLM client (lib/intel/llm). */
import { provider, call, cacheGetText as cacheGet, cacheSetText as cacheSet, hashKey } from '../intel/llm';
import type { TrendData } from './trend-analysis';
import type { CreatorRow } from './creator-analysis';

export async function generateSummary(trend: TrendData, niche?: string | null): Promise<string | null> {
  const nicheLabel = niche?.trim() || 'consumer brands in India';
  const key = hashKey('summary', nicheLabel, trend.source, trend.kpis.posts);
  const cached = await cacheGet(key);
  if (cached) return cached;

  const categories = trend.categories.slice(0, 3).map((c) => `${c.name} (avg score ${c.avg})`).join(', ');
  const formats = trend.formats.slice(0, 3).map((f) => `${f.name} (avg score ${f.avg})`).join(', ');
  const hashtags = trend.hashtags.slice(0, 8).map((h) => `#${h.tag}`).join(' ');

  const prompt =
    `You are an Instagram trend analyst for ${nicheLabel}.\n\n` +
    `Trend snapshot: ${trend.source}\n` +
    `Top categories: ${categories}\n` +
    `Top formats: ${formats}\n` +
    `Top hashtags: ${hashtags}\n` +
    `Top recommendation: post a ${trend.rec.format} in the ${trend.rec.category} niche.\n\n` +
    `Write exactly 3 sentences (no bullets, no headers, no markdown) that tell a brand marketer:\n` +
    `1. What is trending and why it matters\n` +
    `2. Which format and style is driving the highest engagement\n` +
    `3. The one concrete action they should take this week`;

  const summary = await call(prompt, 200);
  if (summary) await cacheSet(key, summary);
  return summary;
}

export type SemanticMatch = { username: string; reason: string };

export async function semanticSearch(
  query: string,
  creatorList: CreatorRow[],
  postsByCreator: Map<string, Array<{ caption: string | null }>>,
): Promise<{ ranked: SemanticMatch[]; error?: string }> {
  if (!provider()) {
    return { ranked: [], error: 'No AI provider configured. Set GROQ_API_KEY or OPENROUTER_API_KEY.' };
  }

  const lines = creatorList.map((cr) => {
    const topCaps = (postsByCreator.get(cr.username) ?? []).slice(0, 3)
      .map((p) => (p.caption ?? '').slice(0, 80)).join(' | ');
    return `@${cr.username}: ${(cr.followers ?? 0).toLocaleString('en-US')} followers, ER ${cr.engagementRate}%, ` +
      `bio: ${(cr.bio ?? '').slice(0, 100)}, recent posts: ${topCaps}`;
  });

  const prompt =
    `You are matching Instagram creators to a brand's requirements.\n\n` +
    `Available creators:\n${lines.join('\n')}\n\n` +
    `Brand is looking for: "${query}"\n\n` +
    `Return a JSON array of matched creators ranked by relevance. Include only genuinely relevant ones.\n` +
    `Format: [{"username": "@name", "reason": "one sentence"}]\n` +
    `Return ONLY the JSON array, no other text.`;

  const raw = await call(prompt, 600);
  if (!raw) return { ranked: [], error: 'AI request failed' };

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return { ranked: [], error: 'Could not parse AI response' };
  try {
    return { ranked: JSON.parse(match[0]) as SemanticMatch[] };
  } catch {
    return { ranked: [], error: 'Could not parse AI response' };
  }
}
