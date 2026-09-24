import type { MetadataRoute } from 'next';

const SITE = 'https://sociafy.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE}/try-image`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE}/try-video`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE}/developers`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE}/legal/privacy`, changeFrequency: 'yearly', priority: 0.2 },
    { url: `${SITE}/legal/terms`, changeFrequency: 'yearly', priority: 0.2 },
  ];
}
