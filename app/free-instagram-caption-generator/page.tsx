import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-instagram-caption-generator',
  'Free Instagram Caption Generator (AI) | Sociafy',
  'Describe your photo or Reel and get 5 scroll-stopping Instagram captions in seconds. Pick a tone, copy the one you like. Free, no sign-up.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="caption"
      h1={<>Free Instagram caption generator, <span className="accent">five hooks in seconds</span>.</>}
      lede="Tell us what your post is about. Get five captions with different hooks, from a punchy one-liner to a short story, ready to paste."
      label="What is your post about?"
      cta="Write my captions"
      examples={[
        'Photo of our new matcha latte, launching this weekend',
        'Carousel: 5 mistakes I made in my first year freelancing',
        'Sunset hike with my dog in the Rockies',
      ]}
      steps={[
        ['Describe the post', 'A sentence is enough: what is in the photo or Reel, and what you want people to feel or do.'],
        ['Pick a tone (optional)', 'Friendly, professional, witty, bold or inspirational. Skip it and we match the topic.'],
        ['Copy your favourite', 'You get five captions with different hooks. Copy one, tweak a word, post it.'],
      ]}
      faq={[
        ['Is this Instagram caption generator free?', 'Yes. It is free with no account and no watermark. There is a fair-use limit of about 10 generations an hour to keep it free for everyone.'],
        ['How long should an Instagram caption be?', 'Instagram allows 2,200 characters, but only the first line or two show before "more". Our captions front-load the hook and stay short, 1 to 4 lines, which works best for most posts.'],
        ['Does it add hashtags?', 'No, captions come without hashtags so they read cleanly. Use our free hashtag generator to get a set of broad, mid-size and niche tags for the same post.'],
        ['Can I use these captions for Reels and carousels?', 'Yes. Mention the format in your description ("Reel", "carousel") and the captions will fit it, for example pointing people to swipe or watch to the end.'],
        ['Can it write captions in my own voice?', 'This free tool writes good general captions. A free Sociafy account learns your voice from your past posts and writes, schedules and posts captions for you every day.'],
      ]}
    />
  );
}
