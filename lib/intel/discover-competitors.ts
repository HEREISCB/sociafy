/* Auto-discover niche competitors from trend posts we already scraped. No new
   scraper: the owners of posts pulled under the tracked niche hashtags ARE the
   accounts in that space. But a generic tag like #hometheatre also pulls
   furniture shops, decor pages and realtors — so we score each owner on how
   much of a LUXURY HOME-AV business they look like (premium brand mentions,
   home-cinema / acoustics / automation vocabulary, high-ticket ₹ pricing) and
   drop the off-space ones (furniture / kitchen / realty / fashion …). Kept
   India-only via caption geo signals. Pure + deterministic (self-check below). */

export type DiscoverPost = {
  owner: string | null;
  caption: string | null;
  postHashtags: string[] | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  ownerFollowers: number | null;
};

export type Candidate = {
  handle: string;
  posts: number;
  engagement: number;
  followers: number;
  indiaScore: number;
  avScore: number; // posts with home-AV vocabulary
  brandScore: number; // posts naming premium AV brands
  luxScore: number; // posts with luxury / high-ticket signals
  negScore: number; // posts reading as an off-space business
  score: number;
};

// +91 numbers, ₹/rupee/lakh/crore pricing, or an Indian city / the word india
const INDIA_RE =
  /(\+?\b91[\s-]?\d{5})|(₹|\brs\.?\b|\binr\b|\blakhs?\b|\bcrores?\b)|\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|chennai|pune|kochi|kerala|kolkata|ahmedabad|surat|jaipur|noida|gurgaon|gurugram|lucknow|indore|nagpur|coimbatore|vijayawada|vizag|mysore|thrissur|calicut|kozhikode)\b/i;

// Neighbour markets share ₹-ish pricing / city names and leak past INDIA_RE.
const NON_INDIA_RE =
  /(\.pk\b|\.lk\d*\b|\.ae\b|\.np\b|\.bd\b)|\b(pakistan|lahore|karachi|islamabad|rawalpindi|colombo|sri[\s-]?lanka|nepal|kathmandu|bangladesh|dhaka|dubai|abu[\s-]?dhabi|sharjah)\b/i;

// core home-AV vocabulary — what an actual competitor talks about
const AV_RE =
  /\b(home\s?(theatre|theater|cinema)|hometheatre|hometheater|homecinema|private\s?cinema|media\s?room|dolby\s?atmos|atmos|dts:?x?|immersive\s?(audio|sound)|surround\s?sound|acoustic(s|\s?treatment|\s?panel)?|soundproof\w*|projector|projection\s?screen|4k\s?laser|home\s?automation|smart\s?home|integrat(ed|ion)\s?(av|audio|home)|av\s?(solution|integration|installation)|audiophile|hi[-\s]?fi|high[-\s]?end\s?audio|theatre\s?room|cinema\s?room)\b/i;

// premium AV brands — a strong "real competitor" signal
const BRAND_RE =
  /\b(bang\s?&?\s?olufsen|b&o|bowers\s?&?\s?wilkins|b&w|kef|focal|marantz|denon|mcintosh|trinnov|storm\s?audio|jbl\s?synthesis|kaleidescape|control\s?4|control4|crestron|lutron|savant|barco|sim2|christie|wisdom\s?audio|sonance|monitor\s?audio|wharfedale|klipsch|polkaudio|elac|arcam|anthem|integra|nad\s?electronics|rotel|jvc\s?projector|epson\s?projector|sony\s?(projector|vpl)|screen\s?innovations|stewart\s?filmscreen|lg\s?laser)\b/i;

// luxury / high-ticket signals
const LUX_RE =
  /\b(luxur\w*|premium|bespoke|turnkey|custom(is|iz)ed?|high[-\s]?end|villa|penthouse|bungalow|mansion|crores?|lakhs?)\b/i;

// off-space businesses that also ride #hometheatre etc — NOT competitors
const NEG_RE =
  /\b(furniture|sofa|recliner|wardrobe|modular\s?kitchen|kitchen\s?interior|curtain|wallpaper|mattress|tiles?|granite|marble|paint(ing|er)?|real\s?estate|realestate|property|properties|builder|apartments?\s?for|flats?\s?for|plots?\s?for|saree|jewell?er|boutique|salon|spa|cafe|restaurant|clothing|apparel|fashion|footwear|cosmetic|solar\s?panel|cctv|water\s?purifier|gym|fitness)\b/i;

const eng = (p: DiscoverPost) => (p.likes ?? 0) + 3 * (p.comments ?? 0) + 0.05 * (p.views ?? 0);
const norm = (h: string) => h.replace(/^@/, '').trim().toLowerCase();

export function discoverCompetitors(
  posts: DiscoverPost[],
  opts: { exclude?: Iterable<string>; limit?: number; requireIndia?: boolean } = {},
): Candidate[] {
  const exclude = new Set([...(opts.exclude ?? [])].map(norm));
  const requireIndia = opts.requireIndia !== false;

  const agg = new Map<string, Candidate>();
  const foreign = new Set<string>();
  for (const p of posts) {
    if (!p.owner) continue;
    const handle = norm(p.owner);
    if (!handle || exclude.has(handle)) continue;
    const hay = `${p.caption ?? ''} ${(p.postHashtags ?? []).join(' ')} ${handle}`;
    if (NON_INDIA_RE.test(handle) || NON_INDIA_RE.test(hay)) foreign.add(handle);
    const c = agg.get(handle) ?? { handle, posts: 0, engagement: 0, followers: 0, indiaScore: 0, avScore: 0, brandScore: 0, luxScore: 0, negScore: 0, score: 0 };
    c.posts++;
    c.engagement += eng(p);
    c.followers = Math.max(c.followers, p.ownerFollowers ?? 0);
    c.indiaScore += INDIA_RE.test(hay) ? 1 : 0;
    c.avScore += AV_RE.test(hay) ? 1 : 0;
    c.brandScore += BRAND_RE.test(hay) ? 1 : 0;
    c.luxScore += LUX_RE.test(hay) ? 1 : 0;
    c.negScore += NEG_RE.test(hay) ? 1 : 0;
    agg.set(handle, c);
  }

  let out = [...agg.values()];
  // must look like a home-AV business (av vocabulary or a named premium brand)
  // and must NOT read as an off-space business (furniture/realty/…-dominant)
  out = out.filter((c) => (c.avScore > 0 || c.brandScore > 0) && c.negScore < Math.max(1, c.avScore + c.brandScore));
  if (requireIndia) out = out.filter((c) => c.indiaScore > 0 && !foreign.has(c.handle));

  // rank on how strongly they read as a luxury AV competitor; brand + av carry it,
  // engagement/frequency only break ties. off-space penalised hard.
  for (const c of out) {
    c.score = Math.round(
      c.brandScore * 400 + c.avScore * 250 + c.luxScore * 150 +
      c.indiaScore * 40 + c.posts * 30 + c.engagement * 0.5 -
      c.negScore * 300,
    );
  }
  out.sort((a, b) => b.score - a.score || b.brandScore - a.brandScore || b.posts - a.posts);
  return out.slice(0, opts.limit ?? 10);
}
