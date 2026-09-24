import type { MetadataRoute } from 'next';
import { FREE_TOOL_PAGES } from '../lib/free-tools';

const SITE = 'https://sociafy.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE, changeFrequency: 'weekly', priority: 1 },
    ...FREE_TOOL_PAGES.map((t) => ({ url: `${SITE}${t.slug}`, changeFrequency: 'monthly' as const, priority: 0.9 })),
    { url: `${SITE}/developers`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE}/legal/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${SITE}/legal/terms`, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
