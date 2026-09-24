import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free AI Reels, TikTok & Shorts Video Generator | Sociafy';
const DESCRIPTION = 'Turn a text prompt into a vertical 9:16 AI video for Instagram Reels, TikTok and YouTube Shorts. Free to try, no sign-up needed.';

export const metadata: Metadata = {
  title: TITLE, description: DESCRIPTION, alternates: { canonical: '/free-reels-video-generator' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/free-reels-video-generator' }, twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="video" path="/free-reels-video-generator" aspect="9:16" toolName="Reels, TikTok and Shorts video generator"
      h1={<>Free AI video generator for <span className="accent">Reels, TikTok and Shorts</span>.</>}
      lede="Describe a scene and get a vertical clip made for short-form feeds. One prompt, ready for Reels, TikTok and Shorts. Free to try, no account needed."
      examples={[
        'Neon city street at night in the rain, slow camera push forward',
        'Hands unboxing a sleek gadget on a clean desk, top-down shot',
        'Waves crashing on black rocks at sunset, slow motion',
      ]}
      steps={[
        ['Describe the scene', 'Subject, motion and camera: "slow push in on…", "top-down shot of…". We polish the prompt for you.'],
        ['Get a vertical clip', 'A 9:16 video that fills the phone screen, the format every short-form feed rewards.'],
        ['Unlock and post everywhere', 'Create a free Sociafy account to remove the watermark and download it, or schedule it to Reels, TikTok and Shorts at once.'],
      ]}
      faq={[
        ['What size is a Reel, TikTok or Short?', 'All three use vertical 9:16 video (1080×1920 at full size). This tool always makes 9:16 clips.'],
        ['How long are the free videos?', 'Free videos are 5-second clips, perfect as a hook or B-roll. Inside Sociafy you can make videos up to 15 seconds in 720p and 1080p.'],
        ['Is it really free?', 'Yes. You get a free video every day without an account. A free account removes the watermark and unlocks the HD download.'],
        ['Can Sociafy post to TikTok, Instagram and YouTube?', 'Yes. Connect your accounts and Sociafy schedules the same clip to Reels, TikTok and Shorts, with a caption for each.'],
        ['Does the video have sound?', 'Clips can include ambient sound from the model. Add music or a voiceover in the app you post from.'],
      ]}
    />
  );
}
