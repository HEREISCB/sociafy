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

const SITE_URL = 'https://sociafy.app';
const OG_IMAGE = `${SITE_URL}/og.png`;
const TITLE = 'Sociafy — AI social agent for founders';
const DESCRIPTION = 'AI-powered social media management for solo founders. Draft, schedule, and autopilot your content across X, LinkedIn, Instagram, Facebook, TikTok, and YouTube.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Sociafy',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: 'Sociafy' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
  icons: {
    icon: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
