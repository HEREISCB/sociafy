import Link from 'next/link';
import { SiteShell } from '../../components/site-chrome';
import { toolMetadata } from '../../components/text-tool-page';
import { HubFilter } from '../../components/landing-islands';
import { Icon } from '../../components/icons';
import { FREE_TOOLS, FREE_TOOL_IDS } from '../../lib/free-tools';
import { TRY_PAGES, TRY_PER_DAY, TRY_WAIT, aspectRatio } from '../../lib/try-presets';
import { tierPriceView } from '../../lib/billing/pricing';

export const metadata = toolMetadata(
  '/free-tools',
  'Free social media tools',
  'Free AI tools for social media: caption, hashtag, LinkedIn post, bio, tweet and YouTube title generators, plus AI images and videos. No sign-up.',
);

type Card = { href: string; kind: 'write' | 'image' | 'video'; name: string; job: string; speed: string; sample?: string; ratio?: string };

const CARDS: Card[] = [
  ...FREE_TOOL_IDS.map((id): Card => ({
    href: FREE_TOOLS[id].slug, kind: 'write', name: FREE_TOOLS[id].title,
    job: FREE_TOOLS[id].blurb, speed: 'Instant', sample: FREE_TOOLS[id].sample,
  })),
  ...TRY_PAGES.map((t): Card => ({
    href: t.path, kind: t.kind === 'image' ? 'image' : 'video', name: t.title.replace(/^Free /, ''),
    job: t.blurb, speed: `${TRY_WAIT[t.kind]} · ${TRY_PER_DAY[t.kind]} a day`, ratio: aspectRatio(t.kind, t.aspect),
  })),
];
const ICON = { write: 'list', image: 'image', video: 'play' } as const;
const count = (k: Card['kind']) => CARDS.filter((c) => c.kind === k).length;

export default function Page() {
  return (
    <SiteShell current="tools">
      <section className="lp hub">
        <p className="lp-eyebrow"><span className="pip" />Free tools · no account needed</p>
        <h1>Free social media tools, one job each.</h1>
        <p className="hero-lede">
          Captions, hashtags, posts, bios, titles, images and videos. Describe what you need and copy the result.
          Writing tools are instant; images and videos take a moment to develop.
        </p>
        <HubFilter counts={{ all: CARDS.length, write: count('write'), image: count('image'), video: count('video') }} />
        <ul className="hub-grid" data-filter="all">
          {CARDS.map((c) => (
            <li key={c.href} data-kind={c.kind}>
              <Link href={c.href} className="card lp-tcard">
                <span className="hub-k">
                  <span className="hub-ic"><Icon name={ICON[c.kind]} /></span>
                  <span className="mono">{c.speed}</span>
                </span>
                <b>{c.name}</b>
                <p>{c.job}</p>
                {c.sample
                  ? <span className="lp-out">{c.sample}</span>
                  : <span className={`hub-shape ${c.kind}`} aria-hidden="true"><i style={{ aspectRatio: c.ratio }} /></span>}
                <span className="lp-go">Open <Icon name="arrow_right" /></span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="card hub-soft">
          <p><b>Want this done every week, in your voice?</b><span>Sociafy plans the month, makes the posts and publishes them. Plans from <span className="mono">{tierPriceView('INR', 'starter').display}</span>/mo.</span></p>
          <div className="lp-cta">
            <Link className="btn lp-pill lp-ghost" href="/#how">How it works</Link>
            <Link className="btn primary lp-pill" href="/sign-up">Get started</Link>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
