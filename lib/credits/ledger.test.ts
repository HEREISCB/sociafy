import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Covers the two ways the ledger could hand out free credits:
 *   - concurrent refunds for the same charge inserting two refund rows
 *   - a retried payment webhook re-granting credits it already granted
 *
 * The `db` mock is deliberately dumb (predicates are ignored; each test seeds a
 * single charge row) but models the two Postgres behaviours the fixes lean on:
 * `profiles … FOR UPDATE` serializing transactions per user, and the partial
 * unique index from drizzle/0008 rejecting a duplicate (user, kind, source).
 */

type Row = {
  id: string;
  userId: string;
  kind: string;
  action: string | null;
  credits: number;
  meta: Record<string, unknown> | null;
  relatedLedgerId: string | null;
};

const rows: Row[] = [];
let nextId = 1;
let lockQueue: Promise<unknown> = Promise.resolve();
let forUpdateCalls = 0;
let orderByCalls = 0;
/** Simulates the dedup scan missing an older row (unordered LIMIT 50). */
let hideGrantsFromScan = false;
/** Simulates a non-idempotency DB failure on insert. */
let insertError: Error | null = null;

function uniqueViolation(): Error & { code: string } {
  const e = new Error(
    'duplicate key value violates unique constraint "credit_ledger_user_kind_source_uniq"',
  ) as Error & { code: string };
  e.code = '23505';
  return e;
}

function sourceOf(meta: unknown): string | undefined {
  const s = (meta as { source?: unknown } | null)?.source;
  return typeof s === 'string' ? s : undefined;
}

type Result = unknown[];

function query(get: () => Result) {
  const chain = {
    limit: () => Promise.resolve(get()),
    orderBy: () => {
      orderByCalls++;
      return chain;
    },
    for: () => {
      forUpdateCalls++;
      return Promise.resolve([]);
    },
    then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(get()).then(res, rej),
  };
  return chain;
}

function executor() {
  return {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          // No columns → the `select()` that loads the original charge row.
          if (!cols) return query(() => rows.filter((r) => r.kind === 'charge'));
          // { total } → the SUM(credits) balance read.
          if ('total' in cols) {
            return query(() => [{ total: rows.reduce((s, r) => s + r.credits, 0) }]);
          }
          // { id, meta } → grantIdempotent's dedup scan.
          if ('meta' in cols) {
            return query(() =>
              hideGrantsFromScan ? [] : rows.filter((r) => sourceOf(r.meta) !== undefined),
            );
          }
          // { id } → either the profile lock (result unused) or the
          // already-refunded check.
          return query(() => rows.filter((r) => r.relatedLedgerId !== null));
        },
      }),
    }),
    insert: () => ({
      values: (v: Partial<Row> & { userId: string; kind: string; credits: number }) => {
        const source = sourceOf(v.meta);
        const dup =
          source !== undefined &&
          rows.some(
            (r) => r.userId === v.userId && r.kind === v.kind && sourceOf(r.meta) === source,
          );
        const fail = insertError ?? (dup ? uniqueViolation() : null);
        if (fail) {
          return {
            returning: () => Promise.reject(fail),
            then: (res: unknown, rej?: (e: unknown) => unknown) => Promise.reject(fail).then(res as never, rej),
          };
        }
        const row: Row = {
          action: null,
          meta: {},
          relatedLedgerId: null,
          ...v,
          id: String(nextId++),
        } as Row;
        rows.push(row);
        const out = [{ id: row.id }];
        return {
          returning: () => Promise.resolve(out),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(out).then(res, rej),
        };
      },
    }),
  };
}

vi.mock('../db', () => ({
  db: () => ({
    ...executor(),
    // pg serializes transactions that take the same profile row lock. Model it
    // as a queue so a "concurrent" pair really does run one after the other.
    transaction: (cb: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      const run = lockQueue.then(() => cb(executor()));
      lockQueue = run.catch(() => undefined);
      return run;
    },
  }),
}));

import { refund, partialRefund, grantIdempotent } from './ledger';

function seedCharge(credits = -100) {
  rows.push({
    id: 'chg1',
    userId: 'u1',
    kind: 'charge',
    action: 'image_medium_1024',
    credits,
    meta: {},
    relatedLedgerId: null,
  });
}

beforeEach(() => {
  rows.length = 0;
  nextId = 1;
  lockQueue = Promise.resolve();
  forUpdateCalls = 0;
  orderByCalls = 0;
  hideGrantsFromScan = false;
  insertError = null;
});

describe('refund', () => {
  it('inserts one refund row when two refunds race the same charge', async () => {
    seedCharge(-100);

    // The video-job poller refunds on the failure path; parallel polls are
    // expected, so this is the real production interleaving.
    const results = await Promise.all([
      refund({ userId: 'u1', ledgerId: 'chg1', reason: 'poll_a' }),
      refund({ userId: 'u1', ledgerId: 'chg1', reason: 'poll_b' }),
    ]);

    expect(results.filter((r) => r.refunded)).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'refund')).toHaveLength(1);
    // Net zero — a double refund would leave the user +100.
    expect(rows.reduce((s, r) => s + r.credits, 0)).toBe(0);
    expect(results.every((r) => r.balanceAfter === 0)).toBe(true);
  });

  it('takes the profile row lock', async () => {
    seedCharge();
    await refund({ userId: 'u1', ledgerId: 'chg1', reason: 'x' });
    expect(forUpdateCalls).toBeGreaterThan(0);
  });

  it('no-ops when the charge does not exist', async () => {
    const r = await refund({ userId: 'u1', ledgerId: 'nope', reason: 'x' });
    expect(r.refunded).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('refunds a charge only once across sequential calls', async () => {
    seedCharge(-250);
    expect((await refund({ userId: 'u1', ledgerId: 'chg1', reason: 'a' })).refunded).toBe(true);
    expect((await refund({ userId: 'u1', ledgerId: 'chg1', reason: 'b' })).refunded).toBe(false);
    expect(rows.filter((r) => r.kind === 'refund')).toHaveLength(1);
  });
});

describe('partialRefund', () => {
  it('inserts one row when two partial refunds race', async () => {
    seedCharge(-100);
    await Promise.all([
      partialRefund({ userId: 'u1', ledgerId: 'chg1', credits: 25, action: 'image_medium_1024', reason: 'a' }),
      partialRefund({ userId: 'u1', ledgerId: 'chg1', credits: 25, action: 'image_medium_1024', reason: 'b' }),
    ]);
    expect(rows.filter((r) => r.kind === 'refund')).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.credits, 0)).toBe(-75);
  });

  it('skips zero/negative amounts without inserting', async () => {
    seedCharge(-100);
    await partialRefund({ userId: 'u1', ledgerId: 'chg1', credits: 0, action: 'image_medium_1024', reason: 'a' });
    expect(rows.filter((r) => r.kind === 'refund')).toHaveLength(0);
  });
});

describe('grantIdempotent under webhook retry', () => {
  const grantArgs = { userId: 'u1', kind: 'topup', credits: 1000, source: 'rzp_topup:pay_abc' } as const;

  it('dedupes on the fast-path scan, ordered newest-first', async () => {
    expect(await grantIdempotent({ ...grantArgs })).toBe(true);
    expect(await grantIdempotent({ ...grantArgs })).toBe(false);
    expect(rows).toHaveLength(1);
    // Without orderBy, pg's row order is unspecified and the scan is unsound.
    expect(orderByCalls).toBeGreaterThan(0);
  });

  it('falls back to the unique index when the row is outside the scan window', async () => {
    expect(await grantIdempotent({ ...grantArgs })).toBe(true);
    hideGrantsFromScan = true;

    expect(await grantIdempotent({ ...grantArgs })).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(1000);
  });

  it('still grants a genuinely different source', async () => {
    expect(await grantIdempotent({ ...grantArgs })).toBe(true);
    expect(await grantIdempotent({ ...grantArgs, source: 'rzp_topup:pay_def' })).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('rethrows DB errors that are not unique violations', async () => {
    insertError = new Error('connection terminated unexpectedly');
    await expect(grantIdempotent({ ...grantArgs })).rejects.toThrow('connection terminated');
  });
});
