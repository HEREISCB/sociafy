import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-youtube-title-generator',
  'Free YouTube Title & Description Generator | Sociafy',
  'Get 5 click-worthy YouTube titles under 70 characters plus 2 SEO-friendly descriptions for your video. Free AI tool, no sign-up needed.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="youtube"
      h1={<>Free YouTube title & description generator, <span className="accent">built for search</span>.</>}
      lede="Describe your video and get five titles under 70 characters plus two ready-to-paste descriptions that front-load your keywords."
      label="What is your video about?"
      cta="Write titles & descriptions"
      examples={[
        'Beginner guide to sourdough bread, no special equipment',
        'I tried waking up at 5am for 30 days',
        'Review of the best budget mechanical keyboards this year',
      ]}
      steps={[
        ['Describe the video', 'The topic, who it is for, and the payoff: what viewers learn or see by the end.'],
        ['Get titles and descriptions', 'Five title options with the keyword up front, then two descriptions with a strong first two lines.'],
        ['Paste into YouTube Studio', 'Copy a title and a description, add your links and chapters, and publish.'],
      ]}
      faq={[
        ['Is the YouTube title generator free?', 'Yes, free with no account. There is a fair-use limit of about 10 generations an hour.'],
        ['How long should a YouTube title be?', 'YouTube allows 100 characters, but titles get cut off around 60 to 70 characters in search and on mobile. Our titles stay under 70 with the main keyword near the start.'],
        ['Why do the first lines of the description matter?', 'Only the first two lines show above “more”, and they appear in search results. The descriptions open with a keyword-rich summary so both viewers and YouTube know what the video is about.'],
        ['Are these titles clickbait?', 'No. They aim for curiosity or a clear benefit without promising something the video does not deliver, which protects your watch time and retention.'],
        ['Does it work for YouTube Shorts?', 'Yes. Mention it is a Short and the titles will be shorter and punchier. Sociafy can also make and post Shorts for you.'],
      ]}
    />
  );
}
