import type { MetadataRoute } from 'next';
import { TRY_PAGES } from '../lib/try-presets';

const SITE = 'https://sociafy.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE, changeFrequency: 'weekly', priority: 1 },
    ...TRY_PAGES.map((t) => ({ url: `${SITE}${t.path}`, changeFrequency: 'monthly' as const, priority: 0.9 })),
    { url: `${SITE}/developers`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE}/legal/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${SITE}/legal/terms`, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
