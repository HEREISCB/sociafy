import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = { id: string; userId: string; kind: string; credits: number; meta: Record<string, unknown> };

const rows: Row[] = [];

vi.mock('../db', () => {
  let nextId = 1;
  return {
    db: () => ({
      select: (_cols: unknown) => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows.map((r) => ({ id: r.id, meta: r.meta }))),
          }),
        }),
      }),
      insert: () => ({
        values: (v: Omit<Row, 'id'>) => {
          const row: Row = { ...v, id: String(nextId++) };
          rows.push(row);
          return { returning: () => Promise.resolve([{ id: row.id }]) };
        },
      }),
    }),
  };
});

import { grantIdempotent } from './ledger';

describe('grantIdempotent', () => {
  beforeEach(() => { rows.length = 0; });

  it('inserts a row when source is new', async () => {
    const wrote = await grantIdempotent({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_abc:pay_xyz',
      meta: { tier: 'pro' },
    });
    expect(wrote).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(6000);
    expect(rows[0].meta).toMatchObject({ source: 'rzp_sub:sub_abc:pay_xyz', tier: 'pro' });
  });

  it('skips when a row with the same source already exists', async () => {
    rows.push({
      id: 'pre-existing',
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      meta: { source: 'rzp_sub:sub_abc:pay_xyz' },
    });

    const wrote = await grantIdempotent({
      userId: 'u1',
      kind: 'monthly_grant',
      credits: 6000,
      source: 'rzp_sub:sub_abc:pay_xyz',
    });

    expect(wrote).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it('stores positive credits even if negative is passed', async () => {
    await grantIdempotent({
      userId: 'u1',
      kind: 'topup',
      credits: -1000,
      source: 'rzp_topup:pay_abc',
    });
    expect(rows[0].credits).toBe(1000);
  });
});
