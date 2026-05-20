import type { ToolSpec } from '../agent-loop';

const UNSPLASH = 'https://api.unsplash.com';
const PEXELS = 'https://api.pexels.com/v1';

export type ImageResult = {
  source: 'unsplash' | 'pexels' | 'stub';
  id: string;
  description: string | null;
  url: string;
  thumb: string;
  attribution: string | null;
};

/**
 * Stock image search. Tries Unsplash first (free, 50 req/h), falls back to
 * Pexels if configured. In dev with neither key set, returns a small stub set
 * so the agent loop still works.
 */
export async function searchImages(query: string, limit = 6): Promise<ImageResult[]> {
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (unsplashKey) {
    const r = await fetchUnsplash(query, limit, unsplashKey);
    if (r.length > 0) return r;
  }
  if (pexelsKey) {
    const r = await fetchPexels(query, limit, pexelsKey);
    if (r.length > 0) return r;
  }
  return stubImages(query, limit);
}

async function fetchUnsplash(query: string, limit: number, key: string): Promise<ImageResult[]> {
  try {
    const url = `${UNSPLASH}/search/photos?query=${encodeURIComponent(query)}&per_page=${Math.min(limit, 10)}&orientation=landscape`;
    const r = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      results: Array<{
        id: string;
        alt_description: string | null;
        description: string | null;
        urls: { regular: string; thumb: string };
        user: { name: string };
        links: { html: string };
      }>;
    };
    return data.results.map((p) => ({
      source: 'unsplash' as const,
      id: p.id,
      description: p.alt_description ?? p.description,
      url: p.urls.regular,
      thumb: p.urls.thumb,
      attribution: `Photo by ${p.user.name} on Unsplash (${p.links.html})`,
    }));
  } catch {
    return [];
  }
}

async function fetchPexels(query: string, limit: number, key: string): Promise<ImageResult[]> {
  try {
    const url = `${PEXELS}/search?query=${encodeURIComponent(query)}&per_page=${Math.min(limit, 10)}&orientation=landscape`;
    const r = await fetch(url, { headers: { Authorization: key } });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      photos: Array<{
        id: number;
        alt: string;
        src: { large: string; small: string };
        photographer: string;
        url: string;
      }>;
    };
    return data.photos.map((p) => ({
      source: 'pexels' as const,
      id: String(p.id),
      description: p.alt,
      url: p.src.large,
      thumb: p.src.small,
      attribution: `Photo by ${p.photographer} on Pexels (${p.url})`,
    }));
  } catch {
    return [];
  }
}

function stubImages(query: string, limit: number): ImageResult[] {
  return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
    source: 'stub' as const,
    id: `stub-${i}`,
    description: `Stub image for "${query}"`,
    url: `https://picsum.photos/seed/${encodeURIComponent(query)}-${i}/1200/675`,
    thumb: `https://picsum.photos/seed/${encodeURIComponent(query)}-${i}/300/170`,
    attribution: 'Stub via picsum.photos (set UNSPLASH_ACCESS_KEY for real results)',
  }));
}

export const searchImagesSkill: ToolSpec = {
  type: 'custom',
  def: {
    type: 'function',
    name: 'search_images',
    description:
      'Search free stock photography (Unsplash / Pexels) for an image that matches a query. ' +
      'Returns up to 6 candidates with URLs and attribution. Use this when a post needs visual support.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Visual concept to search for, e.g. "coffee shop laptop founder".' },
        limit: { type: 'number', description: 'Max results to return. Default 4.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  handler: async (input) => {
    const args = input as { query?: string; limit?: number };
    if (!args.query) return { error: 'query_required' };
    const limit = Math.min(Math.max(args.limit ?? 4, 1), 8);
    const results = await searchImages(args.query, limit);
    return { count: results.length, results };
  },
};
