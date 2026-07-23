/* Port of TACCV/core/creator_analysis.py filter logic; rows come from Postgres. */

export interface CreatorRow {
  username: string;
  followers: number | null;
  following: number | null;
  bio: string | null;
  location: string | null;
  avgLikes: number | null;
  avgComments: number | null;
  engagementRate: number | null;
  botScore: number | null;
  botLabel: string | null;
  botExplanation: string | null;
}

export interface CreatorFilters {
  q?: string;
  flMin?: number;
  flMax?: number;
  erMin?: number;
  erMax?: number;
  location?: string;
}

export function filterCreators<T extends CreatorRow>(rows: T[], f: CreatorFilters): T[] {
  let result = rows;
  if (f.q) {
    const q = f.q.toLowerCase();
    result = result.filter((r) => r.username.toLowerCase().includes(q) || (r.bio ?? '').toLowerCase().includes(q));
  }
  if (f.flMin !== undefined) result = result.filter((r) => (r.followers ?? 0) >= f.flMin!);
  if (f.flMax !== undefined) result = result.filter((r) => (r.followers ?? 0) <= f.flMax!);
  if (f.erMin !== undefined) result = result.filter((r) => r.engagementRate !== null && r.engagementRate >= f.erMin!);
  if (f.erMax !== undefined) result = result.filter((r) => r.engagementRate !== null && r.engagementRate <= f.erMax!);
  if (f.location) {
    const loc = f.location.toLowerCase();
    result = result.filter((r) => (r.location ?? '').toLowerCase().includes(loc));
  }
  return result;
}
