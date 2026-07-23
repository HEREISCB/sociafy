/* Live LinkedIn company scraping via Apify's apimaestro/linkedin-company-detail.
   Input is `{ identifier: [slug] }` (vanity slug, array — supports batch); one
   item back per slug carries firmographics + follower/employee counts under
   nested `basic_info` / `stats` / `locations` / `media` (NO posts feed — this
   actor doesn't return one). Reads are defensive over the nested shape, same
   best-effort style as extractAudio() in apify-client.
   (Was dev_fusion/linkedin-company-scraper — that actor errored on every profile
   incl. Microsoft and returned 0 items, so it was swapped out.) */
import { runActor, toInt } from './apify-client';

const COMPANY_ACTOR = 'apimaestro~linkedin-company-detail';
const SEARCH_ACTOR = 'apimaestro~linkedin-companies-search-scraper';

export type LinkedInCompany = {
  slug: string;
  url: string;
  name: string | null;
  industry: string | null;
  website: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  description: string | null;
  specialities: string[];
  logoUrl: string | null;
  followers: number;
  employees: number;
};

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** first non-empty string among candidate keys */
function pickStr(o: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return null;
}

/** first finite number among candidate keys (accepts "12,345"/"1.2M"-ish via toInt) */
function pickNum(o: Raw, ...keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (v === null || v === undefined || v === '') continue;
    const n = toInt(v);
    if (n) return n;
  }
  return 0;
}

/** extract a 4-digit year from a founded field that may be a number, "1998", or "1998-01" */
function pickYear(o: Raw, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && v > 1800 && v < 2200) return Math.floor(v);
    const m = str(v)?.match(/\b(1[89]\d{2}|2[01]\d{2})\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

function pickSpecialities(o: Raw): string[] {
  const v = o.specialities ?? o.specialties ?? o.specialty;
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => !!s).slice(0, 20);
  const s = str(v);
  return s ? s.split(/[,;]/).map((x) => x.trim()).filter(Boolean).slice(0, 20) : [];
}

/** vanity slug from a LinkedIn company URL, else the input trimmed */
export function linkedinSlug(input: string): string {
  const m = input.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return (m ? m[1] : input).trim().replace(/^@/, '').toLowerCase();
}

export function companyUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input.trim();
  return `https://www.linkedin.com/company/${linkedinSlug(input)}`;
}

export type LinkedInSearchHit = {
  slug: string;
  url: string;
  name: string | null;
  industry: string | null;
  followers: number;
};

/** Search LinkedIn companies by keyword (optionally industry/location ids).
    Returns lightweight hits (url + name + followers) to rank + scrape later. */
export async function searchLinkedInCompanies(
  keyword: string,
  opts: { limit?: number; industryIds?: string; locationIds?: string } = {},
): Promise<LinkedInSearchHit[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const items = await runActor<Raw>(SEARCH_ACTOR, {
    keyword: kw,
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 50),
    ...(opts.industryIds ? { industry_ids: opts.industryIds } : {}),
    ...(opts.locationIds ? { location_ids: opts.locationIds } : {}),
  });

  const out: LinkedInSearchHit[] = [];
  const seen = new Set<string>();
  for (const c of items) {
    // numeric company_id still resolves as /company/{id}; prefer a real url/slug
    const rawUrl = pickStr(c, 'url', 'companyUrl', 'link', 'profileUrl', 'linkedinUrl');
    const id = pickStr(c, 'universalName', 'company_id', 'companyId', 'id');
    const url = rawUrl ?? (id ? `https://www.linkedin.com/company/${id}` : null);
    if (!url) continue;
    const slug = linkedinSlug(url);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      url,
      name: pickStr(c, 'name', 'companyName', 'title'),
      industry: pickStr(c, 'industry', 'industryName'),
      followers: pickNum(c, 'followerCount', 'followers', 'followersCount'),
    });
  }
  return out;
}

const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

/** "City, State, Country" from apimaestro's nested headquarters object. */
function headquartersOf(hq: Raw): string | null {
  const parts = [str(hq.city), str(hq.state), str(hq.country)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Scrape one public LinkedIn company page. Returns null if the actor couldn't
    resolve it (bad slug / private / removed). */
export async function scrapeLinkedInCompany(input: string): Promise<LinkedInCompany | null> {
  const slug = linkedinSlug(input);
  const url = companyUrl(input);
  const items = await runActor<Raw>(COMPANY_ACTOR, { identifier: [slug] });
  const c = items[0];
  if (!c || c.error) return null;
  const basic = obj(c.basic_info);
  const stats = obj(c.stats);
  const media = obj(c.media);
  const hq = obj(obj(c.locations).headquarters);
  // reject a miss (actor echoes input_identifier but returns no real firmographics)
  if (!str(basic.name) && !pickNum(stats, 'follower_count')) return null;

  const industries = Array.isArray(basic.industries) ? basic.industries.map(str).filter(Boolean) : [];
  return {
    slug: str(basic.universal_name) ?? slug,
    url: str(basic.linkedin_url) ?? url,
    name: str(basic.name),
    industry: (industries[0] as string) ?? null,
    website: str(basic.website),
    headquarters: headquartersOf(hq),
    foundedYear: pickYear(obj(basic.founded_info), 'year') ?? pickYear(basic, 'founded', 'foundedYear'),
    description: str(basic.description) ?? str(c.tagline),
    specialities: Array.isArray(basic.specialties)
      ? basic.specialties.map(str).filter((s): s is string => !!s).slice(0, 20)
      : pickSpecialities(basic),
    logoUrl: str(media.logo_url) ?? pickStr(c, 'logoUrl', 'logo'),
    followers: pickNum(stats, 'follower_count', 'followers'),
    employees: pickNum(stats, 'employee_count', 'employees'),
  };
}
