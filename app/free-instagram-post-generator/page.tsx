import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free Instagram Post Generator (AI) | Sociafy';
const DESCRIPTION = 'Make a scroll-stopping Instagram post image from one sentence. Free AI generator in portrait format, no sign-up needed to try.';

export const metadata: Metadata = {
  title: TITLE, description: DESCRIPTION, alternates: { canonical: '/free-instagram-post-generator' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/free-instagram-post-generator' }, twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="image" path="/free-instagram-post-generator" aspect="portrait" toolName="Instagram post generator"
      h1={<>Free Instagram post generator, <span className="accent">made for the feed</span>.</>}
      lede="Describe your post and get a portrait image sized for the Instagram feed, where taller posts take up more of the screen. Free to try, no account needed."
      examples={[
        'Flat lay of a morning routine: journal, coffee and sunlight on linen',
        'Bold minimalist quote card background in warm terracotta tones',
        'Handmade candle on a wooden shelf, soft cozy evening light',
      ]}
      steps={[
        ['Describe the post', 'Say what should be in the picture and the mood. Product, lifestyle, quote background: anything you would post.'],
        ['Get a portrait image', 'It comes out tall (2:3), which fills more of the feed than a square and gets more attention.'],
        ['Unlock and post', 'Create a free Sociafy account to remove the watermark, download it, or schedule it straight to Instagram.'],
      ]}
      faq={[
        ['What size is an Instagram post image?', 'Instagram shows portrait posts up to 4:5. This tool makes a tall 2:3 image, so it fills the feed; Instagram crops it slightly to 4:5 when you post.'],
        ['Is the Instagram post generator free?', 'Yes. You get free generations every day without an account. A free account removes the watermark and unlocks the HD download.'],
        ['Can Sociafy post it to Instagram for me?', 'Yes. Connect your Instagram business or creator account and Sociafy schedules the post at the best time, with a caption written in your voice.'],
        ['Can I use the images for my business?', 'Yes. Images you generate are yours to use in posts, ads and on your website.'],
        ['Does it write captions too?', 'Try the free Instagram caption generator, or let Sociafy write captions and hashtags for every post automatically.'],
      ]}
    />
  );
}
