import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { parseBody, billingDetailsSchema } from '../../../../lib/validation';
import { db } from '../../../../lib/db';
import { profiles, type BillingAddress } from '../../../../lib/db/schema';
import { stateCodeFromGstin } from '../../../../lib/billing/gst';

export const runtime = 'nodejs';

/**
 * GET/PATCH /api/billing/details — the company identity that goes on a GST
 * invoice: registered legal name, GSTIN, PAN, billing address, place of supply.
 *
 * Kept apart from /api/agent/settings (which holds the *brand* profile that
 * feeds the AI) because these are legal fields with their own validation and a
 * different consumer: lib/billing/zoho mirrors them into a Books contact.
 */
export async function GET() {
  return withUser(async (user) => {
    const [p] = await db()
      .select({
        legalName: profiles.legalName,
        gstin: profiles.gstin,
        pan: profiles.pan,
        billingAddress: profiles.billingAddress,
        placeOfSupply: profiles.placeOfSupply,
        billingCountry: profiles.billingCountry,
      })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);

    return {
      legalName: p?.legalName ?? '',
      gstin: p?.gstin ?? '',
      pan: p?.pan ?? '',
      billingAddress: (p?.billingAddress ?? {}) as BillingAddress,
      placeOfSupply: p?.placeOfSupply ?? '',
      billingCountry: p?.billingCountry ?? 'IN',
    };
  });
}

export async function PATCH(req: NextRequest) {
  return withUser(async (user) => {
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(billingDetailsSchema, raw);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const patch: Partial<typeof profiles.$inferInsert> = { updatedAt: new Date() };
    if (body.legalName !== undefined) patch.legalName = body.legalName.trim() || null;
    if (body.gstin !== undefined) patch.gstin = body.gstin || null;
    if (body.pan !== undefined) patch.pan = body.pan || null;
    if (body.billingAddress !== undefined) {
      patch.billingAddress = body.billingAddress;
      if (body.billingAddress.country) patch.billingCountry = body.billingAddress.country.toUpperCase();
    }
    if (body.placeOfSupply !== undefined) patch.placeOfSupply = body.placeOfSupply || null;

    // A GSTIN already names its state in the first two digits. Filling the
    // place of supply from it means one fewer field the user can contradict.
    const fromGstin = stateCodeFromGstin(patch.gstin ?? undefined);
    if (fromGstin && !patch.placeOfSupply) patch.placeOfSupply = fromGstin;

    const [row] = await db()
      .update(profiles)
      .set(patch)
      .where(eq(profiles.id, user.id))
      .returning({
        legalName: profiles.legalName,
        gstin: profiles.gstin,
        pan: profiles.pan,
        billingAddress: profiles.billingAddress,
        placeOfSupply: profiles.placeOfSupply,
        billingCountry: profiles.billingCountry,
      });

    return row;
  }, req);
}
