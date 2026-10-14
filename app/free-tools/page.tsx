import { SiteShell } from '../../components/site-chrome';
import { ToolLinks, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-tools',
  'Free Social Media Tools: AI Captions, Hashtags & More',
  'Free AI tools for social media: caption, hashtag, LinkedIn post, bio, tweet and YouTube title generators, plus AI images and videos. No sign-up.',
);

export default function Page() {
  return (
    <SiteShell>
      <section className="lp tool-hero">
        <p className="tool-eyebrow">Free · no sign-up needed</p>
        <h1>Free social media tools, one job each.</h1>
        <p className="hero-lede">
          Captions, hashtags, posts, bios, titles, images and videos. Pick a tool, describe what you need, and copy the result.
        </p>
        <ToolLinks />
      </section>
    </SiteShell>
  );
}
