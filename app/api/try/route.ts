import { NextRequest, NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../../../lib/db';
import { tryGenerations } from '../../../lib/db/schema';
import { authedUser, jsonError } from '../../../lib/api';
import { isStubMode } from '../../../lib/env';
import { parseBody } from '../../../lib/validation';
import { clientIp, hashIp, runImageTry, submitVideoTry, tryQuota, tryView, VISITOR_COOKIE } from '../../../lib/try';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const maxDuration = 120;

const body = z.object({
  kind: z.enum(['image', 'video']),
  prompt: z.string().trim().min(3).max(600),
});

/** POST /api/try — one free generation, no account needed. Public by design; the quota is the guard. */
export async function POST(req: NextRequest) {
  if (isStubMode.r2()) return jsonError('r2_not_configured', 503);
  const parsed = parseBody(body, await req.json().catch(() => ({})));
  if (!parsed.ok) return parsed.response;
  const { kind, prompt } = parsed.data;

  const user = await authedUser();
  const visitor = req.cookies.get(VISITOR_COOKIE)?.value ?? crypto.randomUUID();
  const ipHash = hashIp(clientIp(req.headers));

  const q = await tryQuota(kind, { visitor, ipHash, userId: user?.id });
  if (q.left === 0) {
    return jsonError('try_limit', 429, {
      hint: user
        ? 'You have used today’s free tries. Your account credits keep going in the Studio.'
        : 'You have used today’s free tries. Create a free Sociafy account to keep generating.',
    });
  }
  if (q.siteFull) return jsonError('try_busy', 429, { hint: 'Free tries are full for today. Come back tomorrow, or sign up to generate now.' });

  const [row] = await db().insert(tryGenerations)
    .values({ kind, prompt, visitor, ipHash, claimedBy: user?.id ?? null })
    .returning();

  if (kind === 'image') {
    after(() => runImageTry(row));
  } else {
    try {
      await submitVideoTry(row);
    } catch (e) {
      console.error('[try] video submit failed', row.id, e);
      await db().update(tryGenerations).set({ status: 'failed', error: 'submit_failed' }).where(eq(tryGenerations.id, row.id));
      return jsonError('try_failed', 502, { hint: 'The video model is busy. Try again in a minute. This did not use your free try.' });
    }
  }

  const res = NextResponse.json(tryView(row, user?.id ?? null));
  res.cookies.set(VISITOR_COOKIE, visitor, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 60 * 60 * 24 * 365, path: '/' });
  return res;
}
