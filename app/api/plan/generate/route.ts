import { NextRequest, after } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { agentSettings } from '../../../../lib/db/schema';
import { planGenerateSchema, parseBody } from '../../../../lib/validation';
import { preparePlan, fillPlan } from '../../../../lib/agent/run';
import { draftCost } from '../../../../lib/credits/estimator';

// POST /api/plan/generate { horizonDays?: 7 | 30 }
// Fill the plan for the horizon (and remember it, so the cron keeps topping up
// to it). Sizing and the run lease are taken synchronously; the drafting
// itself — a model call per 4 posts plus about a minute per image — runs after
// the response. Poll GET /api/plan (`generating`) for progress.
//   202 { status: 'started', planned, slots, credits }  drafting in the background (≤ PLAN_MAX posts; credits ≈ cost)
//   200 { status: 'full' }                        nothing missing
//   409 { status: 'running' }                     a plan run already holds the lease
//   409 { status: 'blocked', reason }             no niches / platforms / credits / cap
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const parsed = parseBody(planGenerateSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    const { horizonDays } = parsed.data;
    if (horizonDays) {
      await db().update(agentSettings).set({ planHorizonDays: horizonDays, updatedAt: new Date() }).where(eq(agentSettings.userId, user.id));
    }

    const plan = await preparePlan(user.id, { horizonDays });
    if (!('ctx' in plan)) {
      if (plan.reason === 'plan_full') return { status: 'full' };
      const status = plan.reason === 'already_running' ? 'running' : 'blocked';
      return Response.json({ status, reason: plan.reason }, { status: 409 });
    }
    after(async () => {
      try {
        await fillPlan(plan);
      } catch (e) {
        console.error('[plan] generate failed:', e instanceof Error ? e.message : String(e));
      }
    });
    return Response.json(
      { status: 'started', planned: plan.kinds.length, credits: plan.kinds.reduce((n, k) => n + draftCost(k), 0), slots: plan.slots.map((d, i) => ({ at: d.toISOString(), kind: plan.kinds[i] })) },
      { status: 202 },
    );
  }, req);
}
