import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-hashtag-generator',
  'Free Hashtag Generator for Instagram & TikTok | Sociafy',
  'Get 30 relevant hashtags for any post, split into broad, mid-size and niche sets for Instagram, TikTok and LinkedIn. Free AI tool, no sign-up.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="hashtag"
      h1={<>Free hashtag generator, <span className="accent">broad to niche</span>.</>}
      lede="Describe your post or niche and get 30 hashtags in three sets: high-reach, community and niche. Mix them to get found by the right people."
      label="What is your post or account about?"
      cta="Generate hashtags"
      examples={[
        'Home workout for busy moms, no equipment',
        'Handmade ceramic mugs, small business in Portland',
        'Tips for first-time startup founders raising a seed round',
      ]}
      steps={[
        ['Describe your post', 'Name the topic, and your niche or location if it matters. More detail gives more specific tags.'],
        ['Get three sets', 'Ten broad tags for reach, ten mid-size community tags, and ten niche tags where you can actually rank.'],
        ['Copy and mix', 'Copy one set, or combine a few tags from each. Paste them into your caption or first comment.'],
      ]}
      faq={[
        ['How many hashtags should I use on Instagram?', 'Instagram allows up to 30, but 3 to 10 well-chosen tags usually work as well or better. A mix of broad and niche tags gives you both reach and a chance to show up in smaller, more engaged feeds.'],
        ['Why are the hashtags split into three groups?', 'Huge tags like #fitness move so fast your post disappears in seconds. Niche tags have fewer posts, so yours stays visible longer. Picking a few from each group balances reach with discoverability.'],
        ['Does this work for TikTok and LinkedIn too?', 'Yes. The tags are relevant across platforms. On TikTok use 3 to 5; on LinkedIn stick to 3 at the end of your post.'],
        ['Is the hashtag generator free?', 'Yes, free with no account. There is a fair-use limit of about 10 generations an hour per visitor.'],
        ['Does it avoid banned hashtags?', 'The generator is told to skip spammy and commonly restricted tags, but Instagram changes its list often, so give any tag you are unsure of a quick search first.'],
      ]}
    />
  );
}
