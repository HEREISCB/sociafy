/* Groq narration over already-computed deterministic signals. One batched,
   cached call per surface. Returns null on no-provider/failure so callers paint
   the deterministic numbers regardless. Numbers are never invented here. */
import { callJson, cacheGetJson, cacheSetJson, hashKey, hasProvider } from './llm';
import type { Forecast } from './forecast';
import type { GeneralBucket } from './general-trends';
import type { TrendData } from '../taccv/trend-analysis';

const NICHE_FALLBACK = 'a premium consumer brand';

export type TrendVerdict = { entity: string; fit: number; verdict: 'go' | 'watch' | 'skip'; tip: string };

/** Blend deterministic niche-fit base with one batched LLM pass over the watchlist. */
export async function strategizeTrends(
  items: Forecast[],
  niche: string | null,
): Promise<Map<string, TrendVerdict>> {
  const out = new Map<string, TrendVerdict>();
  // deterministic fallback verdict from fitBase so UI always has something
  for (const f of items) {
    const base = f.fitBase ?? 0;
    out.set(f.entity, {
      entity: f.entity,
      fit: base,
      verdict: base >= 60 ? 'go' : base >= 35 ? 'watch' : 'skip',
      tip: '',
    });
  }
  if (!hasProvider() || items.length === 0) return out;

  const nicheLabel = niche?.trim() || NICHE_FALLBACK;
  const key = hashKey('trend-verdict', nicheLabel, ...items.map((f) => `${f.entity}:${f.stage}:${f.fitBase ?? 0}`));
  const cached = await cacheGetJson<TrendVerdict[]>(key);
  const llm = cached ?? await callJson<TrendVerdict[]>(
    `You advise ${nicheLabel} on Instagram trend selection.\n` +
    `Each trend below has a stage, hours-until-projected-peak, and a rough niche-fit base (0-100).\n` +
    items.map((f) => `- "${f.entity}" (${f.kind}, ${f.stage}, peak in ${f.hoursToPeak ?? '?'}h, fit base ${f.fitBase ?? 0})`).join('\n') +
    `\n\nFor each, decide how well it fits ${nicheLabel} and whether to act.\n` +
    `"tip" must be a CONCRETE CONTENT IDEA, not generic advice — name the format (reel/carousel/story) and the specific angle ` +
    `${nicheLabel} should film to ride this trend before it peaks. <=18 words. Bad: "Post soon, it's rising." Good: "Reel: before/after room reveal set to this audio, timed for peak."\n` +
    `Return ONLY a JSON array: [{"entity":"<exact name>","fit":<0-100>,"verdict":"go|watch|skip","tip":"<=18 word content idea"}]`,
    700,
  );
  if (cached === null && llm) await cacheSetJson(key, llm);
  if (!llm) return out;

  for (const v of llm) {
    const base = items.find((f) => f.entity === v.entity)?.fitBase ?? v.fit;
    out.set(v.entity, {
      entity: v.entity,
      fit: Math.round(0.5 * base + 0.5 * Math.max(0, Math.min(100, v.fit ?? base))),
      verdict: v.verdict ?? (base >= 60 ? 'go' : 'watch'),
      tip: (v.tip ?? '').slice(0, 120),
    });
  }
  return out;
}

export type CompetitorStrategy = {
  doList: string[];
  dontList: string[];
  plan: { frequency: string; bestDays: string[]; bestTimes: string[]; summary: string };
  audience: { estimate: string; basis: string };
};

/** signals is the deterministic landscape rollup; LLM only narrates it. */
export async function strategizeCompetitors(
  signals: Record<string, unknown>,
  niche: string | null,
): Promise<CompetitorStrategy | null> {
  if (!hasProvider()) return null;
  const nicheLabel = niche?.trim() || NICHE_FALLBACK;
  const key = hashKey('comp-strategy', nicheLabel, JSON.stringify(signals));
  const cached = await cacheGetJson<CompetitorStrategy>(key);
  if (cached) return cached;

  const res = await callJson<CompetitorStrategy>(
    `You are a social strategist for ${nicheLabel} on Instagram.\n` +
    `Here are aggregated, factual signals from the top competitors (all times are IST, India time):\n` +
    JSON.stringify(signals) +
    `\n\nUsing ONLY these signals, produce a strategy. Base every claim on the numbers given; do not invent metrics.\n` +
    `If "opportunityHoursIST" is present, those are LOW-COMPETITION windows — recommend posting there (use them in plan.bestTimes / doList), and NEVER list one of those hours in dontList as a time to avoid.\n` +
    `If "saturatedHoursIST" is present, those are crowded windows — it is fine to advise caution there in dontList, but do not contradict opportunityHoursIST.\n` +
    `For "audience", give a best-guess audience profile ESTIMATED FROM CONTENT SIGNALS ONLY (no real demographic data exists) and say so in "basis".\n` +
    `Always express times in IST (e.g. "6:00 PM IST"), never UTC.\n` +
    `Return ONLY JSON: {"doList":["..."],"dontList":["..."],` +
    `"plan":{"frequency":"e.g. 4 reels/week","bestDays":["Tue"],"bestTimes":["6:00 PM IST"],"summary":"<=25 words"},` +
    `"audience":{"estimate":"<=25 words","basis":"<=15 words"}}`,
    900,
  );
  if (!res) return null;

  // belt-and-suspenders: strip any dontList line that names an opportunity hour
  // as something to avoid — catches the rare case the LLM ignores the instruction above.
  const opportunityHours = Array.isArray((signals as { opportunityHoursIST?: unknown }).opportunityHoursIST)
    ? (signals as { opportunityHoursIST: string[] }).opportunityHoursIST
    : [];
  if (opportunityHours.length && res.dontList?.length) {
    res.dontList = res.dontList.filter((line) => !opportunityHours.some((h) => line.toLowerCase().includes(h.toLowerCase())));
  }

  await cacheSetJson(key, res);
  return res;
}

export type GeneralAngle = GeneralBucket & { angle: string; idea: string };

/** Per-bucket "how *your brand* rides this cultural trend" angle + one concrete
    reel/hook idea. Cached; no provider => buckets pass through with empty
    angle/idea (UI still renders the numbers). */
export async function strategizeGeneral(buckets: GeneralBucket[], niche: string | null): Promise<GeneralAngle[]> {
  const passthrough = buckets.map((b) => ({ ...b, angle: '', idea: '' }));
  if (!hasProvider() || buckets.length === 0) return passthrough;

  const nicheLabel = niche?.trim() || NICHE_FALLBACK;
  const key = hashKey(
    'general-angle', nicheLabel,
    ...buckets.map((b) => `${b.bucket}:${b.topReels.length + b.topPosts.length}:${b.topAudio[0]?.track ?? ''}`),
  );
  const cached = await cacheGetJson<Array<{ bucket: string; angle: string; idea: string }>>(key);
  const llm = cached ?? await callJson<Array<{ bucket: string; angle: string; idea: string }>>(
    `You advise ${nicheLabel} on Instagram. Below are cultural/general trend buckets currently active on Instagram (NOT specific to ${nicheLabel}'s niche).\n` +
    buckets.map((b) => `- "${b.label}" (${b.bucket}): ${b.topReels.length + b.topPosts.length} posts` +
      (b.topAudio[0] ? `, top audio "${b.topAudio[0].track}"` : '')).join('\n') +
    `\n\nFor each bucket give:\n` +
    `"angle" — a one-sentence take on how ${nicheLabel} specifically could ride this cultural trend (<=20 words).\n` +
    `"idea" — one concrete reel/hook idea naming a format. Do not invent facts about the trend beyond what's given above.\n` +
    `Return ONLY a JSON array: [{"bucket":"<exact bucket key>","angle":"<=20 words","idea":"<=20 words"}]`,
    700,
  );
  if (cached === null && llm) await cacheSetJson(key, llm);
  if (!llm) return passthrough;

  const byBucket = new Map(llm.map((a) => [a.bucket, a]));
  return buckets.map((b) => ({
    ...b,
    angle: (byBucket.get(b.bucket)?.angle ?? '').slice(0, 200),
    idea: (byBucket.get(b.bucket)?.idea ?? '').slice(0, 200),
  }));
}

export type BrandStrategy = {
  hooksToFollow: string[];
  weeklyPlan: string;
  trendsToRide: string[];
  summary: string;
};

type NicheRec = TrendData['rec'];

function fallbackBrandStrategy(nicheRec: NicheRec | null, generalBuckets: GeneralBucket[], competitorLandscape: Record<string, unknown> | null): BrandStrategy {
  const avgPostsPerWeek = typeof competitorLandscape?.avgPostsPerWeek === 'number' ? competitorLandscape.avgPostsPerWeek : null;
  return {
    hooksToFollow: (nicheRec?.hooks ?? []).map((h) => h.hook),
    weeklyPlan: avgPostsPerWeek
      ? `Aim for ~${Math.max(3, Math.round(avgPostsPerWeek))} posts/week, matching top competitors' cadence.`
      : 'Aim for 3-4 posts/week, mixing reels and carousels.',
    trendsToRide: generalBuckets.filter((b) => b.topReels.length + b.topPosts.length > 0).map((b) => b.label),
    summary: '',
  };
}

/** The Strategist persona: one senior-IG-strategist pass consuming the niche
    recommendation, general-trend buckets, and competitor landscape together.
    Cached. Deterministic fallback surfaces the existing rec.hooks + a simple
    posting cadence — no narration, but never empty. */
export async function buildBrandStrategy(
  input: { nicheRec: NicheRec | null; generalBuckets: GeneralBucket[]; competitorLandscape: Record<string, unknown> | null },
  niche: string | null,
): Promise<BrandStrategy> {
  const { nicheRec, generalBuckets, competitorLandscape } = input;
  const fallback = fallbackBrandStrategy(nicheRec, generalBuckets, competitorLandscape);
  if (!hasProvider()) return fallback;

  const nicheLabel = niche?.trim() || NICHE_FALLBACK;
  const key = hashKey(
    'brand-strategy', nicheLabel,
    nicheRec?.category ?? '', (nicheRec?.hooks ?? []).map((h) => h.hook).join(';'),
    generalBuckets.map((b) => b.bucket).join(','),
    JSON.stringify(competitorLandscape ?? {}),
  );
  const cached = await cacheGetJson<BrandStrategy>(key);
  if (cached) return cached;

  const res = await callJson<BrandStrategy>(
    `You are a senior Instagram strategist for ${nicheLabel}. Consume the analysis below and produce ONE unified content strategy.\n` +
    `Niche recommendation: best category "${nicheRec?.category || 'n/a'}", best format "${nicheRec?.format || 'n/a'}", top hooks: ${JSON.stringify((nicheRec?.hooks ?? []).map((h) => h.hook))}.\n` +
    `Cultural/general trend buckets currently active: ${generalBuckets.map((b) => b.label).join(', ') || 'none'}.\n` +
    (competitorLandscape ? `Competitor landscape signals: ${JSON.stringify(competitorLandscape)}.\n` : '') +
    `\nUsing ONLY the information given (do not invent numbers), return ONLY JSON:\n` +
    `{"hooksToFollow":["<=6 short hooks, prefer the niche hooks given"],` +
    `"weeklyPlan":"<=30 word posting cadence recommendation",` +
    `"trendsToRide":["<=5 cultural trend names worth riding"],` +
    `"summary":"<=30 word overall strategy summary"}`,
    900,
  );
  if (!res) return fallback;

  await cacheSetJson(key, res);
  return res;
}
