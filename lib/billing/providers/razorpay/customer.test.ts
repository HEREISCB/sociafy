import { describe, it, expect, beforeEach, vi } from 'vitest';

type ProfileRow = { id: string; razorpayCustomerId: string | null; email: string | null; displayName: string | null };
let profileRows: ProfileRow[] = [];
const updates: Array<{ id: string; vals: Record<string, unknown> }> = [];

vi.mock('../../../db', () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(profileRows),
        }),
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (clause: { __whereId: string }) => {
          updates.push({ id: clause.__whereId, vals });
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: string) => ({ __whereId: val }),
}));

const createCustomer = vi.fn();
vi.mock('./client', () => ({
  getRazorpay: () => ({ customers: { create: createCustomer } }),
}));

vi.mock('@clerk/nextjs/server', () => ({
  currentUser: vi.fn(),
}));
import { currentUser } from '@clerk/nextjs/server';

import { ensureRazorpayCustomer } from './customer';

describe('ensureRazorpayCustomer', () => {
  beforeEach(() => {
    profileRows = [];
    updates.length = 0;
    createCustomer.mockReset();
    (currentUser as ReturnType<typeof vi.fn>).mockReset();
  });

  it('returns existing customer id without calling Razorpay', async () => {
    profileRows = [{ id: 'u1', razorpayCustomerId: 'cust_existing', email: 'a@b.com', displayName: 'A' }];
    const id = await ensureRazorpayCustomer('u1');
    expect(id).toBe('cust_existing');
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('creates a Razorpay customer when none exists, then writes id back', async () => {
    profileRows = [{ id: 'u1', razorpayCustomerId: null, email: 'a@b.com', displayName: 'Alex' }];
    (currentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      emailAddresses: [{ emailAddress: 'a@b.com' }],
      firstName: 'Alex', lastName: 'Doe',
    });
    createCustomer.mockResolvedValue({ id: 'cust_new' });

    const id = await ensureRazorpayCustomer('u1');

    expect(id).toBe('cust_new');
    expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({
      email: 'a@b.com',
      name: 'Alex Doe',
      notes: { sociafy_user_id: 'u1' },
    }));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'u1', vals: { razorpayCustomerId: 'cust_new' } });
  });
});
