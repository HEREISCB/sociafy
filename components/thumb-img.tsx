import Image from 'next/image';

const R2 = (process.env.NEXT_PUBLIC_R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');

/**
 * A small preview of an R2 image/poster, resized by Next's image optimizer (next.config `images.remotePatterns`)
 * instead of pulling the multi-MB original into a 40–80px tile. Anything not on our R2 host (blob: uploads in
 * flight, third-party URLs) renders as-is; next/image already passes .svg through untouched.
 * `size` is the tile's CSS px; the browser picks the 1x/2x width from srcset. Styling comes from the parent's `img` rule.
 */
export function ThumbImg({ src, alt, size }: { src: string; alt: string; size: number }) {
  const ours = Boolean(R2) && src.startsWith(`${R2}/`);
  return <Image src={src} alt={alt} width={size} height={size} sizes={`${size}px`} unoptimized={!ours} />;
}
