import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-linkedin-post-generator',
  'Free LinkedIn Post Generator (AI) | Sociafy',
  'Turn a rough idea into 3 LinkedIn posts with a strong hook, clean line breaks and a closing question. Free AI writer, no sign-up needed.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="linkedin"
      h1={<>Free LinkedIn post generator, <span className="accent">from rough notes to ready</span>.</>}
      lede="Paste an idea, a lesson or a few bullet points. Get three LinkedIn posts with a hook that earns the “see more” click and no corporate clichés."
      label="What do you want to post about?"
      cta="Write my LinkedIn posts"
      examples={[
        'We cut our onboarding time from 2 weeks to 3 days, here is how',
        'Lessons from my first year as an engineering manager',
        'Announcing our seed round, thanking early customers',
      ]}
      steps={[
        ['Drop in your idea', 'A topic, a story, a win or messy notes. Specific numbers and details make the best posts.'],
        ['Choose a tone (optional)', 'Professional for announcements, friendly for stories, bold for opinions.'],
        ['Copy, tweak, post', 'Pick the draft that sounds most like you, add a personal detail, and post it.'],
      ]}
      faq={[
        ['Is this LinkedIn post generator free?', 'Yes, it is free with no account needed. There is a fair-use limit of about 10 generations an hour.'],
        ['How long should a LinkedIn post be?', 'Posts of roughly 100 to 200 words tend to do well: long enough to share one real insight, short enough to read in a scroll. Our drafts land in that range.'],
        ['Why does the first line matter so much?', 'LinkedIn cuts posts off after two or three lines with “see more”. If the first line does not earn the click, nobody reads the rest, so every draft opens with a hook.'],
        ['Will the posts sound like AI?', 'The generator avoids the usual clichés (“I’m humbled to announce”) and writes short paragraphs with one concrete point. Adding a detail only you know makes it unmistakably yours.'],
        ['Can Sociafy post to LinkedIn for me?', 'Yes. A free Sociafy account connects your LinkedIn, writes posts in your voice and schedules them at the best time, on autopilot or with your approval.'],
      ]}
    />
  );
}
