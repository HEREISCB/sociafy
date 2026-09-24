import { TextToolPage, toolMetadata } from '../../components/text-tool-page';

export const metadata = toolMetadata(
  '/free-bio-generator',
  'Free Social Media Bio Generator (AI) | Sociafy',
  'Get 5 short bios under 150 characters for Instagram, TikTok, X or LinkedIn. Describe yourself or your brand, pick a tone, copy. Free, no sign-up.',
);

export default function Page() {
  return (
    <TextToolPage
      tool="bio"
      h1={<>Free social media bio generator, <span className="accent">under 150 characters</span>.</>}
      lede="Say who you are and who you help. Get five short bios that fit Instagram’s 150-character limit and work on TikTok, X and LinkedIn too."
      label="Who are you, and who is your account for?"
      cta="Write my bios"
      examples={[
        'Freelance UX designer helping SaaS startups, based in Berlin',
        'Vegan bakery in Austin, custom cakes and weekend brunch',
        'Personal trainer, strength training for women over 40',
      ]}
      steps={[
        ['Describe yourself', 'What you do, who it is for, and anything that makes you different: a place, a result, a quirk.'],
        ['Pick a vibe (optional)', 'Witty for creators, professional for consultants, inspirational for coaches.'],
        ['Copy it to your profile', 'Every bio is under 150 characters, so it fits Instagram without trimming.'],
      ]}
      faq={[
        ['How long can a bio be?', 'Instagram allows 150 characters, X allows 160, and LinkedIn headlines allow 220. TikTok is shorter on many accounts, so pick a tighter option there. Our bios stay under 150.'],
        ['What makes a good social media bio?', 'Say what you do, who it is for, and why someone should follow, in plain words. A clear bio beats a clever one; a little personality on top is a bonus.'],
        ['Can I use this for a business account?', 'Yes. Describe the business, your location if you serve locals, and what customers get. The bios will read like a brand, not a person.'],
        ['Is the bio generator free?', 'Yes, free with no account. There is a fair-use limit of about 10 generations an hour.'],
        ['What should I do after updating my bio?', 'Post consistently so new visitors see an active account. Sociafy can plan and post for you across Instagram, TikTok, X, LinkedIn and more.'],
      ]}
    />
  );
}
