/* Real, transparent creator-authenticity check — replaces the old creators
   table, which was seed-only static demo data with zero live ingestion path
   (no add/refresh route existed; botScore came straight from a CSV). This
   computes a deterministic heuristic score from an actual scraped IG profile:
   no ML model, no black box — every point deducted is named in the
   explanation so the UI's "verification" number means something. */
import type { ScrapedProfile } from '../scrapers/competitors';

export type CreatorAudit = {
  followers: number;
  following: number;
  bio: string | null;
  avgLikes: number;
  avgComments: number;
  engagementRate: number;
  botScore: number;
  botLabel: 'Likely authentic' | 'Uncertain' | 'Likely inauthentic';
  botExplanation: string;
};

function label(score: number): CreatorAudit['botLabel'] {
  if (score >= 70) return 'Likely authentic';
  if (score >= 40) return 'Uncertain';
  return 'Likely inauthentic';
}

export function auditCreator(p: ScrapedProfile): CreatorAudit {
  const posts = p.posts;
  const avgLikes = posts.length ? Math.round(posts.reduce((a, x) => a + x.likes, 0) / posts.length) : 0;
  const avgComments = posts.length ? Math.round(posts.reduce((a, x) => a + x.comments, 0) / posts.length) : 0;
  const engagementRate = p.followers > 0 && posts.length
    ? Math.round(((avgLikes + avgComments) / p.followers) * 10000) / 100
    : 0;

  let score = 100;
  const flags: string[] = [];

  if (p.following > 0 && p.followers > 500 && p.following > p.followers * 3) {
    score -= 30;
    flags.push(`follows ${p.following.toLocaleString('en-US')} but only ${p.followers.toLocaleString('en-US')} follow back — follow-for-follow pattern`);
  }
  if (posts.length >= 3 && p.followers > 1000 && engagementRate < 0.3) {
    score -= 35;
    flags.push(`engagement rate (${engagementRate}%) is far below what ${p.followers.toLocaleString('en-US')} real followers would produce — possible purchased followers`);
  }
  if (engagementRate > 20) {
    score -= 15;
    flags.push(`engagement rate (${engagementRate}%) is abnormally high — possible engagement pods or bot activity`);
  }
  if (posts.length > 0 && posts.length < 3) {
    score -= 10;
    flags.push('very few recent posts sampled — limited signal, treat score as provisional');
  }
  if (!p.bio) {
    score -= 5;
    flags.push('no bio set');
  }

  score = Math.max(0, Math.min(100, score));
  const botExplanation = flags.length
    ? flags.map((f) => `• ${f}`).join('\n')
    : 'No red flags in follower ratio, engagement rate, or posting history.';

  return {
    followers: p.followers, following: p.following, bio: p.bio,
    avgLikes, avgComments, engagementRate,
    botScore: score, botLabel: label(score), botExplanation,
  };
}
