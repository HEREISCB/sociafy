import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free AI YouTube Thumbnail Maker | Sociafy';
const DESCRIPTION = 'Create a click-worthy YouTube thumbnail background from a text prompt. Free AI thumbnail maker in 16:9-style landscape, no sign-up to try.';

export const metadata: Metadata = {
  title: TITLE, description: DESCRIPTION, alternates: { canonical: '/free-youtube-thumbnail-maker' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/free-youtube-thumbnail-maker' }, twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="image" path="/free-youtube-thumbnail-maker" aspect="landscape" toolName="YouTube thumbnail maker"
      h1={<>Free AI YouTube thumbnail maker, <span className="accent">built for clicks</span>.</>}
      lede="Describe your video and get a bold, high-contrast landscape image for your thumbnail. Free to try, no account needed."
      examples={[
        'Shocked person pointing at a giant glowing laptop screen, bright studio colors',
        'Before and after split of a messy desk turned into a clean minimal setup',
        'Dramatic close-up of a burger with flames behind it, high contrast',
      ]}
      steps={[
        ['Describe the video', 'What is the video about, and what emotion should the thumbnail sell? Surprise, curiosity, results.'],
        ['Get a landscape image', 'It comes out wide (3:2) with strong contrast and a clear subject that still reads at small sizes.'],
        ['Unlock and add your title', 'Create a free Sociafy account to remove the watermark and download it, then add your title text in any editor.'],
      ]}
      faq={[
        ['What size is a YouTube thumbnail?', 'YouTube recommends 1280×720 (16:9). This tool makes a 1536×1024 landscape image; crop the top and bottom slightly to get exactly 16:9.'],
        ['Does it add text to the thumbnail?', 'AI images are best as the background and subject. Add your title in YouTube Studio, Canva or any editor for crisp, readable text.'],
        ['Is the thumbnail maker free?', 'Yes. You get free generations every day without an account. A free account removes the watermark and unlocks the HD download.'],
        ['What makes a thumbnail get clicks?', 'One clear subject, a readable emotion, high contrast and very little clutter. Describe exactly that in your prompt.'],
        ['Can Sociafy publish to YouTube?', 'Yes. Sociafy connects to YouTube and schedules your videos and Shorts alongside the rest of your social posts.'],
      ]}
    />
  );
}
