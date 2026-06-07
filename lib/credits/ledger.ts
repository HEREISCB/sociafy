/**
 * Credit ledger primitives.
 *
 * Design: append-only signed-credit ledger.
 *   credits > 0 → user gained credits  (grant, topup, refund)
 *   credits < 0 → user spent credits  (charge)
 *
 * Balance for a user = SUM(credits) WHERE user_id = ?.
 *
 * We don't materialize balance into profiles. With pg's SUM over an
 * indexed (user_id, created_at) it's fast at our scale, and avoiding the
 * write removes a race between balance update and ledger insert.
 *
 * Atomicity: `charge` opens a transaction, takes a row-level lock on the
 * user's profiles row (SELECT … FOR UPDATE), re-reads the balance under
 * that lock, and inserts the debit row only if the balance covers it.
 * Two concurrent charges for the same user serialize on the profile lock,
 * which closes the SUM-then-INSERT race that would otherwise let parallel
 * requests both pass the check and overspend.
 */

import { sql, eq, desc, and } from 'drizzle-orm';
import { db } from '../db';
import {
  creditLedger,
  profiles,
  type CreditLedgerKind,
} from '../db/schema';
import type { CreditAction } from './pricing';

/** Thrown by `charge` when the user's locked balance is below the cost. */
export class InsufficientCreditsError extends Error {
  readonly balance: number;
  readonly needed: number;
  constructor(balance: number, needed: number) {
    super(`insufficient_credits: balance=${balance} needed=${needed}`);
    this.name = 'InsufficientCreditsError';
    this.balance = balance;
    this.needed = needed;
  }
}

/** Sum SUM(credits) for a user. Returns 0 for users with no ledger rows. */
export async function getBalance(userId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`COALESCE(SUM(${creditLedger.credits}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

/**
 * Pre-flight balance check. Returns either { ok: true, balance } or
 * { ok: false, balance, needed }. Use this BEFORE calling expensive
 * upstream APIs.
 */
export async function ensureBalance(
  userId: string,
  needed: number,
): Promise<{ ok: true; balance: number } | { ok: false; balance: number; needed: number }> {
  const balance = await getBalance(userId);
  if (balance < needed) {
    return { ok: false, balance, needed };
  }
  return { ok: true, balance };
}

/**
 * Record a charge. `credits` should be the cost (positive number), it gets
 * stored as a negative ledger entry. Returns the inserted row id so the
 * caller can use it as the related_ledger_id on a later refund.
 *
 * Atomic: opens a transaction, takes a row-level lock on the user's profile,
 * re-checks balance under the lock, and only inserts if balance >= cost.
 * Throws `InsufficientCreditsError` otherwise — callers that pre-flighted
 * with `ensureBalance` shouldn't see this in normal use, but it closes the
 * parallel-request overspend race.
 */
export async function charge(args: {
  userId: string;
  action: CreditAction;
  credits: number;
  meta?: Record<string, unknown>;
}): Promise<{ ledgerId: string; balanceAfter: number }> {
  const cost = Math.abs(args.credits);
  return db().transaction(async (tx) => {
    // Lock the profile row. Concurrent charges for the same user serialize
    // here; one txn must commit/rollback before the next reads balance.
    await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, args.userId))
      .for('update');

    const [bal] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${creditLedger.credits}), 0)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, args.userId));
    const balance = Number(bal?.total ?? 0);

    if (balance < cost) {
      throw new InsufficientCreditsError(balance, cost);
    }

    const [row] = await tx
      .insert(creditLedger)
      .values({
        userId: args.userId,
        kind: 'charge',
        action: args.action,
        credits: -cost,
        meta: args.meta ?? {},
      })
      .returning({ id: creditLedger.id });

    return { ledgerId: row.id, balanceAfter: balance - cost };
  });
}

/**
 * Reverse a previous charge. Use when an upstream API call fails after we
 * already deducted credits. Inserts a positive ledger row referencing the
 * original charge. Idempotent: calling refund() twice for the same
 * ledgerId is a no-op (the second call sees an existing refund row).
 */
export async function refund(args: {
  userId: string;
  ledgerId: string;
  reason: string;
}): Promise<{ refunded: boolean; balanceAfter: number }> {
  // Find the original charge.
  const [original] = await db()
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.id, args.ledgerId), eq(creditLedger.userId, args.userId)))
    .limit(1);
  if (!original) {
    return { refunded: false, balanceAfter: await getBalance(args.userId) };
  }
  // Already refunded? Check for an existing refund pointing at this row.
  const existing = await db()
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, args.userId), eq(creditLedger.relatedLedgerId, args.ledgerId)))
    .limit(1);
  if (existing.length > 0) {
    return { refunded: false, balanceAfter: await getBalance(args.userId) };
  }
  // Insert opposite-signed row. Sign of `credits` flip so the net is zero.
  await db().insert(creditLedger).values({
    userId: args.userId,
    kind: 'refund',
    action: original.action,
    credits: -original.credits,
    meta: { reason: args.reason, refundOf: args.ledgerId },
    relatedLedgerId: args.ledgerId,
  });
  return { refunded: true, balanceAfter: await getBalance(args.userId) };
}

/**
 * Refund a specific number of credits referencing an earlier charge. Used
 * when generation partially succeeds — e.g. user requested 4 images but
 * only 3 came back, refund the cost of the missing 1.
 *
 * `credits` is the positive number of credits to return. Caller is
 * responsible for ensuring this doesn't exceed the original charge.
 */
export async function partialRefund(args: {
  userId: string;
  ledgerId: string;
  credits: number;
  action: CreditAction;
  reason: string;
}): Promise<{ balanceAfter: number }> {
  if (args.credits <= 0) {
    return { balanceAfter: await getBalance(args.userId) };
  }
  await db().insert(creditLedger).values({
    userId: args.userId,
    kind: 'refund',
    action: args.action,
    credits: Math.abs(args.credits),
    meta: { reason: args.reason, partialOf: args.ledgerId },
    relatedLedgerId: args.ledgerId,
  });
  return { balanceAfter: await getBalance(args.userId) };
}

/** Grant credits (signup_bonus, monthly_grant, topup, admin_grant). */
export async function grant(args: {
  userId: string;
  kind: Extract<CreditLedgerKind, 'signup_bonus' | 'monthly_grant' | 'topup' | 'admin_grant'>;
  credits: number;
  meta?: Record<string, unknown>;
}): Promise<{ ledgerId: string; balanceAfter: number }> {
  const [row] = await db()
    .insert(creditLedger)
    .values({
      userId: args.userId,
      kind: args.kind,
      action: null,
      credits: Math.abs(args.credits),
      meta: args.meta ?? {},
    })
    .returning({ id: creditLedger.id });
  return { ledgerId: row.id, balanceAfter: await getBalance(args.userId) };
}

/**
 * Idempotently grant the signup bonus. Returns true if a row was inserted.
 * Called from ensureProfile after profile insert.
 */
export async function ensureSignupBonus(userId: string, credits: number): Promise<boolean> {
  const existing = await db()
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, 'signup_bonus')))
    .limit(1);
  if (existing.length > 0) return false;
  await grant({
    userId,
    kind: 'signup_bonus',
    credits,
    meta: { reason: 'profile_created' },
  });
  return true;
}

/** Recent ledger rows for the usage UI. */
export async function recentLedger(userId: string, limit = 50) {
  return db()
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit);
}

/** Insufficient-credits Response builder. 402 with a structured payload the UI can render. */
export function insufficientCreditsResponse(args: { balance: number; needed: number }): Response {
  return new Response(
    JSON.stringify({
      error: 'insufficient_credits',
      balance: args.balance,
      needed: args.needed,
      hint: `You need ${args.needed} credits but have ${args.balance}. Top up or upgrade your plan.`,
    }),
    {
      status: 402,
      headers: { 'content-type': 'application/json' },
    },
  );
}

/**
 * Idempotent grant keyed by `meta.source`. Used by both Stripe and
 * Razorpay webhooks so that retried events do not double-credit a user.
 *
 * Implementation note: we scan the user's recent monthly_grant /
 * topup rows and check for a matching source in TS rather than relying
 * on a JSONB unique index (cheaper to ship, fast enough at our scale).
 * A future migration can promote `meta.source` to a true unique
 * constraint.
 */
export async function grantIdempotent(args: {
  userId: string;
  kind: Extract<CreditLedgerKind, 'monthly_grant' | 'topup'>;
  credits: number;
  source: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const recent = await db()
    .select({ id: creditLedger.id, meta: creditLedger.meta })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, args.userId), eq(creditLedger.kind, args.kind)))
    .limit(50);

  const dup = recent.find(
    (row) => (row.meta as Record<string, unknown> | null)?.source === args.source,
  );
  if (dup) return false;

  await db()
    .insert(creditLedger)
    .values({
      userId: args.userId,
      kind: args.kind,
      action: null,
      credits: Math.abs(args.credits),
      meta: { source: args.source, ...(args.meta ?? {}) } as Record<string, unknown>,
    })
    .returning({ id: creditLedger.id });
  return true;
}
