/* Shared hashtag normalization for niche/general comparisons. Must match the
   sanitization apify.ts applies before querying (strip non-alphanumeric) —
   otherwise a tracked hashtag stored with punctuation (e.g. "Bang&Olufsen")
   won't match the cleaned tag actually stored as trendPosts.hashtagQueried
   ("BangOlufsen"), and gets silently mislabeled as "general". */
export function normalizeHashtag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}
