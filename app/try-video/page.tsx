import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free AI Video Generator — Text to Video Online | Sociafy';
const DESCRIPTION = 'Turn a text prompt into a short AI video for Reels, TikTok and Shorts. Free to try, no sign-up needed to generate.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/try-video' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/try-video' },
  twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="video"
      h1={<>Free AI video generator, <span className="accent">text to video</span>.</>}
      lede="Describe a scene and get a vertical video clip made for Reels, TikTok and Shorts. Try it free right here, no account needed to generate."
      steps={[
        ['Describe your video', 'Write what happens in the scene: subject, motion, camera, mood. We polish your prompt automatically.'],
        ['We render it', 'A cinematic video model renders your clip, usually in one to three minutes. Keep the tab open.'],
        ['Unlock and download', 'Create a free Sociafy account to remove the watermark, download the HD video, and post it to your socials.'],
      ]}
      faq={[
        ['Is the AI video generator really free?', 'Yes. You get a free video generation every day. You can generate without an account; a free account removes the watermark and unlocks the HD download.'],
        ['Why does my video have a watermark?', 'Free previews carry a Sociafy watermark. Create a free Sociafy account and the clean, full-quality video downloads straight away and is saved to your media library.'],
        ['How long are the videos?', 'Free videos are 5-second vertical 9:16 clips. Inside Sociafy you can make longer videos, up to 15 seconds, in 720p and 1080p.'],
        ['Can I use the videos commercially?', 'Yes. Videos you generate are yours to use in posts, ads and on your website.'],
        ['What else does Sociafy do?', 'Sociafy is an AI social media agent. It writes posts in your voice, makes images and videos for them, and schedules them across X, LinkedIn, Instagram, Facebook, TikTok and YouTube.'],
      ]}
    />
  );
}
