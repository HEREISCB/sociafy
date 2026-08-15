import { describe, it, expect } from 'vitest';
import { isBrandRelevant, filterByBrand } from './sources';

/**
 * The brand-relevance guard. Every mention passes through this before it is
 * scored or stored (lib/shield/monitor.ts).
 *
 * The off-brand cases below are real rows from production: a Wikipedia search
 * for `"New Delhi Municipal Council Official" lawsuit investigation` returned
 * these pages, and because the snippet echoed the query words back
 * ("investigation", "lawsuit"), scoreMention labelled them crises for a
 * customer who is a municipal council in Delhi.
 */

const NDMC = 'New Delhi Municipal Council Official';
const m = (title: string, body = '') => ({ title, body });

describe('isBrandRelevant — off-brand results are rejected', () => {
  const offBrand: [string, string][] = [
    ['Malaysia Airlines Flight 17', 'The responsibility for investigation was delegated to the Dutch Safety Board (DSB) and the Dutch-led joint investigation team (JIT), which in 2016'],
    ['Minamata disease', 'suspect in the investigation. Despite this, from September 1958, instead of discharging its waste into Hyakken Harbour'],
    ['Giorgia Meloni', 'In July 2024, Meloni was awarded damages in a defamation lawsuit against journalist Giulia Cortese'],
    ['Jyoti Basu', 'abuse by police personnel. The incident led to sharp criticism of the government and raised controversy in the media'],
    ['2026 Tamil Nadu Legislative Assembly election', 'while persistent corruption allegations, despite the absence of any major scandals'],
    // Contains "New", "Delhi" AND "Council" — but not "Municipal". Sharing
    // geography with the brand is not being about the brand.
    ['Bhopal disaster', 'Studies on the Factors Related to Bhopal Toxic Gas Leakage (PDF). New Delhi: Indian Council on Scientific and Industrial Research.'],
    ['Law enforcement in India', 'the New Delhi lab is under the Central Bureau of Investigation, and investigates cases on its behalf'],
  ];

  for (const [title, body] of offBrand) {
    it(`rejects "${title}"`, () => {
      expect(isBrandRelevant(m(title, body), NDMC)).toBe(false);
    });
  }

  it('rejects a Wikipedia hit for another company entirely', () => {
    // A Wikipedia search for "Zomato controversy criticism scandal" really does
    // return "Uber" as a top result.
    expect(isBrandRelevant(m('Uber', 'Uber faced a lawsuit over driver classification and an investigation by regulators.'), 'Zomato')).toBe(false);
  });
});

describe('isBrandRelevant — on-brand results are kept', () => {
  it('keeps an article naming the brand', () => {
    expect(isBrandRelevant(m('Swachh Survekshan: New Delhi Municipal Council tops list, Delhi corporations put up dismal show'), NDMC)).toBe(true);
  });

  it('keeps a genuine on-brand crisis', () => {
    expect(
      isBrandRelevant(
        m('New Delhi Municipal Council faces lawsuit over demolition drive', 'A fraud investigation into council contracts has been opened.'),
        NDMC,
      ),
    ).toBe(true);
  });

  it('matches the acronym of a 3+ word brand', () => {
    expect(isBrandRelevant(m('NDMC starts campaign to increase student enrolment in its schools'), NDMC)).toBe(true);
  });

  it('ignores case, punctuation and corporate suffixes', () => {
    expect(isBrandRelevant(m("ZOMATO's Q3 results beat estimates"), 'Zomato Ltd.')).toBe(true);
    expect(isBrandRelevant(m('Acme Widgets recalls a batch'), 'Acme Widgets Pvt Ltd')).toBe(true);
  });

  it('matches the brand words in any order or position', () => {
    expect(isBrandRelevant(m('Municipal body of New Delhi — the Council said on Monday')  , NDMC)).toBe(true);
  });
});

describe('isBrandRelevant — X handles', () => {
  // Synthetic, deliberately: this shape (someone @-mentions the org's handle and
  // never writes its name) is why monitor.ts passes the resolved handle through
  // as an alias. Real scraped posts stay out of the repo.
  const tweet = m('Dear @tweetndmc - fallen tree on the main road is blocking traffic, please clear it.');

  it('keeps a tweet that names the resolved handle instead of the org name', () => {
    expect(isBrandRelevant(tweet, NDMC, ['tweetndmc'])).toBe(true);
    expect(isBrandRelevant(tweet, NDMC, ['@tweetndmc'])).toBe(true);
  });

  it('drops it without the alias — which is why monitor.ts passes the handle', () => {
    expect(isBrandRelevant(tweet, NDMC)).toBe(false);
  });

  it('keeps X results when the brand itself is the handle', () => {
    expect(isBrandRelevant(tweet, 'tweetndmc')).toBe(true);
  });
});

describe('isBrandRelevant — degenerate brands', () => {
  it('does not filter when the brand has no matchable words', () => {
    // "H&M" tokenises to two single letters; filtering on those would be noise,
    // so the guard stands down rather than dropping everything.
    expect(isBrandRelevant(m('Anything at all'), 'H&M')).toBe(true);
  });
});

describe('filterByBrand', () => {
  it('keeps only on-brand items', () => {
    const items = [
      { id: '1', source: 'wikipedia', url: '', title: 'Minamata disease', body: 'focus of investigation', author: '', engagement: 0, timestamp: 0 },
      { id: '2', source: 'google_news', url: '', title: 'NDMC official arrested', body: '', author: '', engagement: 0, timestamp: 0 },
    ] as Parameters<typeof filterByBrand>[0];
    expect(filterByBrand(items, NDMC).map(i => i.id)).toEqual(['2']);
  });
});
