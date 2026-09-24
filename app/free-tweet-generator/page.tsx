import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-tweet-generator',
  'Free Tweet Generator for X (Twitter) | Sociafy',
  'Get 5 punchy X posts under 280 characters: a hot take, a tip, a mini-story, a question and a list. Free AI tweet writer, no sign-up.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="tweet"
      h1={<>Free tweet generator, <span className="accent">five angles on one idea</span>.</>}
      lede="Give it a topic and get five X posts under 280 characters, each in a different format, so you can pick the one that fits your feed."
      label="What do you want to tweet about?"
      cta="Write my tweets"
      examples={[
        'Why most side projects never get their first user',
        'Our app just hit 1,000 users',
        'Remote work tip: protect your mornings from meetings',
      ]}
      steps={[
        ['Enter a topic', 'An idea, an opinion, a launch or a lesson. One line is plenty.'],
        ['Set the tone (optional)', 'Witty and bold get more replies; professional suits announcements.'],
        ['Copy and post', 'Every draft is under 280 characters, so it fits a single post on X.'],
      ]}
      faq={[
        ['Is the tweet generator free?', 'Yes. No account, no watermark. There is a fair-use limit of about 10 generations an hour.'],
        ['Why five different formats?', 'The same idea lands differently as a hot take, a practical tip, a short story, a question or a list. Seeing all five helps you pick what your audience responds to.'],
        ['Does it write threads?', 'This tool writes single posts. For a thread, generate a few posts on related points and chain them, or let Sociafy write full threads for you.'],
        ['Should I use hashtags on X?', 'Rarely. Hashtags on X mostly add clutter; one relevant tag at most. The drafts skip them unless the topic needs one.'],
        ['Can Sociafy post to X for me?', 'Yes. A free Sociafy account connects X, writes posts in your voice from trends in your niche, and schedules them on autopilot.'],
      ]}
    />
  );
}
