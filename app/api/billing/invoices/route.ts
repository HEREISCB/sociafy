import { desc, eq } from 'drizzle-orm';
import { withUser } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { invoices } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/billing/invoices — the user's GST invoices, newest first.
 *
 * `url` is Zoho's own share link (the same one it emails). Serving that rather
 * than proxying the PDF ourselves keeps this to one column and no auth dance;
 * it is a bearer link, so it is only ever returned to the invoice's owner.
 */
export async function GET() {
  return withUser(async (user) => {
    const rows = await db()
      .select()
      .from(invoices)
      .where(eq(invoices.userId, user.id))
      .orderBy(desc(invoices.createdAt))
      .limit(60);

    return {
      invoices: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        number: r.zohoInvoiceNumber,
        url: r.status === 'issued' ? r.zohoInvoiceUrl : null,
        currency: r.currency,
        grossMinor: r.grossMinor,
        taxableMinor: r.taxableMinor,
        taxMinor: r.taxMinor,
        taxRatePct: r.taxRatePct,
        description: (r.meta as { description?: string })?.description ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
