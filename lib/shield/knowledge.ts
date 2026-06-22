/**
 * lib/shield/knowledge.ts
 *
 * Assembles a user's brand knowledge base (shield_documents rows) into a single
 * budgeted context string injected into crisis-response generation.
 *
 * v1 is naive concatenation under a character budget — no embeddings. When the
 * KB outgrows the budget, swap getBrandKnowledge() for a vector-retrieval pass
 * (chunk + embed + pgvector) keyed on the mention text; callers don't change.
 */

import { eq, desc } from 'drizzle-orm';
import { db } from '../db';
import { shieldDocuments } from '../db/schema';

/** Default budget — keeps the injected KB well under the model context while
 *  leaving room for the prompt + allegation. */
const DEFAULT_BUDGET = 6000;

export async function getBrandKnowledge(
  userId: string,
  budgetChars = DEFAULT_BUDGET,
): Promise<string> {
  const rows = await db()
    .select({ title: shieldDocuments.title, content: shieldDocuments.content })
    .from(shieldDocuments)
    .where(eq(shieldDocuments.userId, userId))
    .orderBy(desc(shieldDocuments.updatedAt));

  if (rows.length === 0) return '';

  const parts: string[] = [];
  let used = 0;
  for (const r of rows) {
    const block = `## ${r.title}\n${r.content.trim()}`;
    if (used + block.length > budgetChars) {
      // Fit a partial slice of this doc if there's meaningful room left, then stop.
      const remaining = budgetChars - used;
      if (remaining > 200) parts.push(block.slice(0, remaining));
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join('\n\n');
}
