import { LPNav, Footer } from '../../components/landing';
import { ToolLinks, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-tools',
  'Free Social Media Tools: AI Captions, Hashtags & More',
  'Free AI tools for social media: caption, hashtag, LinkedIn post, bio, tweet and YouTube title generators, plus AI images and videos. No sign-up.',
);

export default function Page() {
  return (
    <>
      <LPNav />
      <main id="main">
        <section className="hero" style={{ textAlign: 'center' }}>
          <div className="lp">
            <span className="hero-eyebrow"><span className="pill">FREE</span> No sign-up needed</span>
            <h1 style={{ maxWidth: 820, margin: '16px auto' }}>Free social media tools, <span className="accent">one job each</span>.</h1>
            <p className="hero-lede" style={{ maxWidth: 640, margin: '0 auto 28px' }}>
              Captions, hashtags, posts, bios, titles, images and videos. Pick a tool, describe what you need, and copy the result.
            </p>
            <div style={{ maxWidth: 960, margin: '0 auto', textAlign: 'left' }}>
              <ToolLinks />
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
