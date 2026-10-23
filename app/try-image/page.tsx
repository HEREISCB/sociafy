import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

export const metadata: Metadata = {
  title: 'Free AI image generator: text to image',
  description: 'Turn a text prompt into an AI image for posts on Instagram, LinkedIn and X. Free, no sign-up needed to generate.',
  alternates: { canonical: '/try-image' },
};

export default function Page() {
  return (
    <TryPage
      kind="image"
      h1={<>Free AI image generator, <span className="accent">from one sentence</span>.</>}
      lede="Describe what you want and get a sharp, post-ready image. Free tool, no account needed to generate."
      steps={[
        ['Describe your image', 'Write a sentence: the subject, the setting, the mood. We polish your prompt automatically for better results.'],
        ['We generate it', 'A state-of-the-art image model draws it in about half a minute.'],
        ['Unlock and download', 'Create a Sociafy account to remove the watermark, download the HD image, and post it straight to your socials.'],
      ]}
      faq={[
        ['Is the AI image generator really free?', 'Yes. You get 2 free images a day per browser. You can generate without an account; an account removes the watermark and unlocks the HD download.'],
        ['Why does my image have a watermark?', 'Free previews carry a Sociafy watermark. Create a Sociafy account and the clean, full-quality image downloads straight away and is saved to your media library.'],
        ['Can I use the images commercially?', 'Yes. Images you generate are yours to use in posts, ads and on your website.'],
        ['What size are the images?', 'Free images are 1024×1024 squares, a good fit for Instagram, LinkedIn and X. Inside Sociafy you can also make portrait and landscape images at higher quality.'],
        ['What else does Sociafy do?', 'Sociafy is an AI social media agent. It writes posts in your voice, makes images and videos for them, and schedules them across X, LinkedIn, Instagram, Facebook, TikTok and YouTube.'],
      ]}
    />
  );
}
