import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free AI Image Generator — Text to Image Online | Sociafy';
const DESCRIPTION = 'Turn a text prompt into a high-quality AI image in seconds. Free to try, no sign-up needed to generate. Made for social posts on Instagram, LinkedIn and X.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/try-image' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/try-image' },
  twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="image"
      h1={<>Free AI image generator, <span className="accent">from one sentence</span>.</>}
      lede="Describe what you want and get a sharp, post-ready image. Try it free right here, no account needed to generate."
      steps={[
        ['Describe your image', 'Write a sentence: the subject, the setting, the mood. We polish your prompt automatically for better results.'],
        ['We generate it', 'A state-of-the-art image model draws it in about half a minute.'],
        ['Unlock and download', 'Create a free Sociafy account to see the full-quality image, download it, and post it straight to your socials.'],
      ]}
      faq={[
        ['Is the AI image generator really free?', 'Yes. Everyone gets free image generations every day. You can generate without an account; a free account unlocks the full-quality download.'],
        ['Why is my image blurred?', 'The preview stays blurred until you create a free Sociafy account. Sign up and the same image unlocks instantly, and it is saved to your media library.'],
        ['Can I use the images commercially?', 'Yes. Images you generate are yours to use in posts, ads and on your website.'],
        ['What size are the images?', 'Free images are 1024×1024 squares, a good fit for Instagram, LinkedIn and X. Inside Sociafy you can also make portrait and landscape images at higher quality.'],
        ['What else does Sociafy do?', 'Sociafy is an AI social media agent. It writes posts in your voice, makes images and videos for them, and schedules them across X, LinkedIn, Instagram, Facebook, TikTok and YouTube.'],
      ]}
    />
  );
}
