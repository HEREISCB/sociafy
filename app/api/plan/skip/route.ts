import { NextRequest } from 'next/server';
import { withUser, jsonError } from '../../../../lib/api';
import { planSkipSchema, parseBody } from '../../../../lib/validation';
import { skipDraft } from '../../../../lib/agent/plan';

// POST /api/plan/skip { draftId } → { ok: true } | 404 not_found
// Archives the draft and frees its slot; the next top-up may refill it.
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const parsed = parseBody(planSkipSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.response;
    return (await skipDraft(user.id, parsed.data.draftId)) ? { ok: true } : jsonError('not_found', 404);
  }, req);
}
