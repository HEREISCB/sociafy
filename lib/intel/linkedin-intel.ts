/* Pure, deterministic rollups for the LinkedIn competitor tab. Growth from a
   daily metrics series + a cross-company landscape aggregate. Self-check at
   bottom (run: `npx tsx lib/intel/linkedin-intel.ts`). */

export type LiMetric = { date: string; followers: number | null; employees: number | null };

export type LiCompany = {
  id: string;
  slug: string;
  name: string | null;
  industry: string | null;
  website: string | null;
  headquarters: string | null;
  foundedYear: number | null;
  specialities: string[];
  logoUrl: string | null;
  followers: number;
  employees: number;
  metrics: LiMetric[]; // ascending by date
};

/** % change first→last of a series, 1 decimal. 0 when no baseline to grow from. */
export function growthPct(series: Array<number | null>): number {
  const vals = series.filter((v): v is number => v != null && v > 0);
  if (vals.length < 2) return 0;
  const first = vals[0];
  const last = vals[vals.length - 1];
  return Math.round(((last - first) / first) * 1000) / 10;
}

export type LiLandscape = {
  count: number;
  totalFollowers: number;
  avgFollowers: number;
  avgEmployees: number;
  topFollowerGain: { slug: string; name: string | null; pct: number } | null;
  topHeadcountGain: { slug: string; name: string | null; pct: number } | null;
  industries: Array<{ industry: string; count: number }>;
};

export function linkedinLandscape(companies: LiCompany[]): LiLandscape | null {
  if (companies.length === 0) return null;

  const totalFollowers = companies.reduce((a, c) => a + c.followers, 0);
  const avgFollowers = Math.round(totalFollowers / companies.length);
  const avgEmployees = Math.round(companies.reduce((a, c) => a + c.employees, 0) / companies.length);

  const withGrowth = companies.map((c) => ({
    slug: c.slug,
    name: c.name,
    followerPct: growthPct(c.metrics.map((m) => m.followers)),
    headcountPct: growthPct(c.metrics.map((m) => m.employees)),
  }));

  const topBy = (key: 'followerPct' | 'headcountPct') => {
    const best = [...withGrowth].sort((a, b) => b[key] - a[key])[0];
    return best && best[key] > 0 ? { slug: best.slug, name: best.name, pct: best[key] } : null;
  };

  const ind = new Map<string, number>();
  for (const c of companies) {
    const i = (c.industry ?? '').trim();
    if (i) ind.set(i, (ind.get(i) ?? 0) + 1);
  }
  const industries = [...ind.entries()]
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count);

  return {
    count: companies.length,
    totalFollowers,
    avgFollowers,
    avgEmployees,
    topFollowerGain: topBy('followerPct'),
    topHeadcountGain: topBy('headcountPct'),
    industries,
  };
}
