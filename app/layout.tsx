import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Every page title is "<page> · Sociafy"; the landing page gets the default.
// Pages only set title, description and canonical. og:/twitter: title and
// description are filled from those, and the image comes from
// app/opengraph-image.png, so pages must not set their own openGraph/twitter
// (that would replace this block and drop the image and site name).
// Icons are file conventions too: app/icon.svg, app/favicon.ico, app/apple-icon.png, app/manifest.ts.
export const metadata: Metadata = {
  metadataBase: new URL('https://sociafy.app'),
  title: {
    default: 'Sociafy · A month of social posts in one sitting',
    template: '%s · Sociafy',
  },
  description: 'Sociafy drafts the captions, images and videos for X, LinkedIn, Instagram, Facebook, TikTok and YouTube in your voice. You review the plan, approve it, and it posts on schedule.',
  openGraph: { type: 'website', siteName: 'Sociafy' },
  twitter: { card: 'summary_large_image' },
};

const REVEAL_READY = `try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches){var d=document.documentElement;d.classList.add('reveal-ready');setTimeout(function(){if(!window.__revealBooted)d.classList.remove('reveal-ready')},4000)}}catch(e){}`;

// Focus rings show for keyboard users only (primitives.css "Focus"): Tab turns them on, any pointer press turns them off.
const KBD_FOCUS = `(function(d){addEventListener('keydown',function(e){if(e.key==='Tab')d.setAttribute('data-kbd','')},true);addEventListener('pointerdown',function(){d.removeAttribute('data-kbd')},true)})(document.documentElement)`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FAFAF7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // No ClerkProvider here: it lives in app/(app)/layout.tsx so public pages
  // (landing, legal, try-*) don't ship the Clerk client bundle.
  // suppressHydrationWarning: browser extensions (password managers, etc.)
  // inject attributes like `bis_register`/`__processed_*` onto <html>/<body>
  // before React hydrates, which otherwise throws a hydration mismatch
  // (React #418) and blanks the page for those users.
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      {/* Plain inline script, not next/script: it must run before first paint.
          Scroll reveals only hide content under html.reveal-ready, so with JS
          off or reduced motion nothing is ever hidden. If the observer
          (components/reveal-observer.tsx) hasn't booted within 4s, drop the
          class so content can never stay stuck invisible. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: REVEAL_READY + ';' + KBD_FOCUS }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
