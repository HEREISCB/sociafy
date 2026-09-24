import type { Metadata } from 'next';
import { TryPage } from '../../components/try-page';

const TITLE = 'Free AI YouTube Video Generator (16:9) | Sociafy';
const DESCRIPTION = 'Create a widescreen 16:9 AI video clip for YouTube intros and B-roll from a text prompt. Free to try, no sign-up needed.';

export const metadata: Metadata = {
  title: TITLE, description: DESCRIPTION, alternates: { canonical: '/free-youtube-video-generator' },
  openGraph: { title: TITLE, description: DESCRIPTION, url: '/free-youtube-video-generator' }, twitter: { title: TITLE, description: DESCRIPTION },
};

export default function Page() {
  return (
    <TryPage
      kind="video" path="/free-youtube-video-generator" aspect="16:9" toolName="YouTube video generator"
      h1={<>Free AI video generator for <span className="accent">YouTube intros and B-roll</span>.</>}
      lede="Describe a shot and get a widescreen 16:9 clip for your channel: intros, transitions and B-roll you don't have to film. Free to try, no account needed."
      examples={[
        'Cinematic aerial shot over mountains at sunrise, slow and smooth',
        'Close-up of hands typing code on a laptop, shallow depth of field',
        'Time-lapse of clouds moving over a modern city skyline',
      ]}
      steps={[
        ['Describe the shot', 'Say what the camera sees and how it moves. Aerial, close-up, time-lapse, slow motion.'],
        ['Get a widescreen clip', 'A 16:9 video that drops straight into a YouTube timeline as an intro or B-roll.'],
        ['Unlock and download', 'Create a free Sociafy account to remove the watermark and download the HD clip.'],
      ]}
      faq={[
        ['What format is a YouTube video?', 'Regular YouTube videos are widescreen 16:9. For Shorts, use the vertical Reels, TikTok and Shorts generator instead.'],
        ['How long are the free clips?', 'Free clips are 5 seconds, ideal for intros and B-roll. Inside Sociafy you can make clips up to 15 seconds in 720p and 1080p.'],
        ['Is it free?', 'Yes. You get a free video every day without an account. A free account removes the watermark and unlocks the HD download.'],
        ['Can I use the clips in monetized videos?', 'Yes. Clips you generate are yours to use, including in monetized videos.'],
        ['What else does Sociafy do for YouTube?', 'Sociafy writes titles and descriptions, and schedules your videos and Shorts alongside your other social posts.'],
      ]}
    />
  );
}
