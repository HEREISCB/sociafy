import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free LinkedIn Post Image Generator (AI) | Sociafy';
const DESCRIPTION = 'Generate a professional image for your LinkedIn post from one sentence. Free AI generator in landscape format, no sign-up needed to try.';

export const metadata: Metadata = {
  title: TITLE, description: DESCRIPTION, alternates: { canonical: '/free-linkedin-image-generator' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/free-linkedin-image-generator' }, twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="image" path="/free-linkedin-image-generator" aspect="landscape" toolName="LinkedIn image generator"
      h1={<>Free LinkedIn image generator, <span className="accent">no stock photos</span>.</>}
      lede="Posts with an image get far more attention on LinkedIn. Describe your idea and get a clean, professional landscape visual. Free to try, no account needed."
      examples={[
        'Clean isometric illustration of a small team building a product roadmap',
        'Founder giving a talk on a small stage, warm light, candid photo style',
        'Minimal abstract chart going up and to the right, navy and white',
      ]}
      steps={[
        ['Describe the idea', 'What is your post about? A lesson, a launch, a milestone. Describe the picture that fits it.'],
        ['Get a landscape visual', 'It comes out wide, the format that shows fullest in the LinkedIn feed on desktop and mobile.'],
        ['Unlock and post', 'Create a free Sociafy account to remove the watermark, download it, or schedule it to LinkedIn with a post in your voice.'],
      ]}
      faq={[
        ['What image size is best for LinkedIn posts?', 'LinkedIn shows landscape images around 1200×627 (1.91:1) and handles 3:2 well. This tool makes a 1536×1024 landscape image.'],
        ['Is the LinkedIn image generator free?', 'Yes. You get free generations every day without an account. A free account removes the watermark and unlocks the HD download.'],
        ['Will it look like a stock photo?', 'Describe something specific to your post and it will not. Illustrations and candid photo styles tend to feel the most authentic on LinkedIn.'],
        ['Can Sociafy write the LinkedIn post too?', 'Yes. Sociafy learns your writing voice and drafts LinkedIn posts for you, with images, on a schedule you approve.'],
        ['Can I use the images commercially?', 'Yes. Images you generate are yours to use in posts, ads and on your website.'],
      ]}
    />
  );
}
