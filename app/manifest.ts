import type { MetadataRoute } from 'next';

// Icons are rendered from app/icon.svg (the ink "S." mark); the maskable one has no
// corner radius and a smaller mark so Android's mask never clips it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sociafy',
    short_name: 'Sociafy',
    description: 'Plan, write and schedule a month of social posts in one sitting.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#FAFAF7',
    theme_color: '#FAFAF7',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
