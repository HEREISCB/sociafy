/**
 * Raise GST invoices in Zoho Books for captured Razorpay payments.
 *
 * Flow per payment:
 *   1. Claim the payment by INSERTing an `invoices` row (status 'pending').
 *      The unique (user_id, source) index is the idempotency lock — a replayed
 *      webhook collides here and issues nothing.
 *   2. Upsert the Zoho contact from the profile's GST details.
 *   3. Create the invoice with `is_inclusive_tax` (our prices already contain
 *      the 18%), mark it sent, record the payment against it, email it.
 *   4. Stamp the row 'issued' with Zoho's number + share URL.
 *
 * Anything that goes wrong stamps 'failed' + the error and returns — this is
 * called from a payment webhook and must never throw there, because the money
 * has already moved and the credits have already been granted. The hourly
 * `reissue-invoices` cron retries failed rows.
 *
 * Zoho decides CGST+SGST vs IGST itself, from the contact's place_of_supply
 * against the org's own state. We do not compute that split; we only mirror
 * the totals locally so an `invoices` row is readable when Zoho is down.
 */

import { and, desc, eq, lt, or } from 'drizzle-orm';
import { db } from '../../db';
import { profiles, invoices, type InvoiceKind, type BillingAddress } from '../../db/schema';
import { env, isStubMode } from '../../env';
import { GST_RATE_PCT, minorToMajor, splitInclusive, stateCodeFromGstin, zohoStateCode } from '../gst';
import { zoho } from './client';

/**
 * Zoho state code of the supplier — GNIX Semiconductors Pvt Ltd, Greater
 * Noida, Uttar Pradesh (see the address in app/billing/page.tsx). Under
 * s.12(2)(b) IGST Act the place of supply for an unregistered recipient whose
 * address is not on record is the supplier's location, so this is the fallback
 * when a customer gave us neither a GSTIN nor a state.
 */
const HOME_STATE_ZOHO = 'UP';

/** Give up on a row after this many failed attempts; it needs a human. */
const MAX_ATTEMPTS = 8;

export type IssueInvoiceArgs = {
  userId: string;
  kind: InvoiceKind;
  /** Idempotency key, e.g. `rzp_topup:pay_XXX`. Same convention as the ledger. */
  source: string;
  /** Tax-INCLUSIVE amount actually captured, in paise. */
  grossMinor: number;
  /** Line-item description, e.g. "Sociafy Pro — monthly subscription". */
  description: string;
  providerPaymentId?: string;
  meta?: Record<string, unknown>;
};

export type IssueInvoiceResult =
  | { ok: true; invoiceNumber: string | null; skipped?: 'already_issued' }
  | { ok: false; error: string };

/** Never throws. Safe to call straight from a payment webhook. */
export async function issueInvoice(args: IssueInvoiceArgs): Promise<IssueInvoiceResult> {
  const split = splitInclusive(args.grossMinor);

  // 1. Claim. onConflictDoNothing returns [] when this payment was already
  //    invoiced (or is mid-flight in a concurrent delivery).
  const [claimed] = await db()
    .insert(invoices)
    .values({
      userId: args.userId,
      kind: args.kind,
      source: args.source,
      providerPaymentId: args.providerPaymentId ?? null,
      grossMinor: split.grossMinor,
      taxableMinor: split.taxableMinor,
      taxMinor: split.taxMinor,
      taxRatePct: split.ratePct,
      status: 'pending',
      meta: { ...(args.meta ?? {}), description: args.description },
    })
    .onConflictDoNothing({ target: [invoices.userId, invoices.source] })
    .returning({ id: invoices.id });

  let rowId = claimed?.id;
  if (!rowId) {
    const [existing] = await db()
      .select({ id: invoices.id, status: invoices.status, number: invoices.zohoInvoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.userId, args.userId), eq(invoices.source, args.source)))
      .limit(1);
    if (!existing) return { ok: false, error: 'claim_lost' };
    if (existing.status === 'issued') {
      return { ok: true, invoiceNumber: existing.number, skipped: 'already_issued' };
    }
    rowId = existing.id;
  }

  return raise(rowId, args, split);
}

async function raise(
  rowId: string,
  args: IssueInvoiceArgs,
  split: ReturnType<typeof splitInclusive>,
): Promise<IssueInvoiceResult> {
  const fail = async (error: string): Promise<IssueInvoiceResult> => {
    console.error(`[zoho.invoice] ${args.source}: ${error}`);
    await db()
      .update(invoices)
      .set({
        status: 'failed',
        error: error.slice(0, 500),
        attempts: (await attemptsOf(rowId)) + 1,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, rowId));
    return { ok: false, error };
  };

  if (isStubMode.zoho()) return fail('zoho_not_configured');

  try {
    const contactId = await ensureZohoContact(args.userId);
    const [profile] = await db()
      .select({ gstin: profiles.gstin, country: profiles.billingCountry, email: profiles.email })
      .from(profiles)
      .where(eq(profiles.id, args.userId))
      .limit(1);

    // Export of services: zero-rated, so no tax_id on the line. Domestic sales
    // carry the 18% GST tax id and Zoho splits it by place of supply.
    const isExport = (profile?.country ?? 'IN') !== 'IN';

    // Resume rather than re-create. A crash between Zoho accepting the invoice
    // and us storing its id would otherwise have the retry raise a SECOND
    // invoice for the same payment — the one duplicate the (user_id, source)
    // index can't catch, because both attempts share the same row.
    const [row] = await db()
      .select({ zohoInvoiceId: invoices.zohoInvoiceId })
      .from(invoices)
      .where(eq(invoices.id, rowId))
      .limit(1);

    let inv: ZohoInvoice;
    let resumed = false;
    if (row?.zohoInvoiceId) {
      inv = (await zoho<{ invoice: ZohoInvoice }>(`/invoices/${row.zohoInvoiceId}`)).invoice;
      resumed = true;
    } else {
      const created = await zoho<{ invoice: ZohoInvoice }>('/invoices', {
        method: 'POST',
        body: {
          customer_id: contactId,
          date: todayInIST(),
          reference_number: args.providerPaymentId ?? args.source,
          // Our headline prices already contain the GST — do not let Zoho add
          // 18% on top of ₹2,999 and invoice for more than the card was charged.
          is_inclusive_tax: !isExport,
          line_items: [
            {
              name: args.description.slice(0, 100),
              description: args.description,
              rate: minorToMajor(split.grossMinor),
              quantity: 1,
              hsn_or_sac: env.zoho.sacCode,
              ...(isExport || !env.zoho.gstTaxId ? {} : { tax_id: env.zoho.gstTaxId }),
            },
          ],
          notes: `Paid via Razorpay${args.providerPaymentId ? ` · ${args.providerPaymentId}` : ''}. This is a computer-generated invoice.`,
        },
      });
      inv = created.invoice;
      if (!inv?.invoice_id) return fail('zoho_returned_no_invoice_id');
      // Persist the id BEFORE anything else can throw.
      await db()
        .update(invoices)
        .set({
          zohoInvoiceId: inv.invoice_id,
          zohoInvoiceNumber: inv.invoice_number ?? null,
          zohoInvoiceUrl: inv.invoice_url ?? null,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, rowId));
    }
    if (!inv?.invoice_id) return fail('zoho_returned_no_invoice_id');

    // Everything below is best-effort relative to the invoice itself: the
    // invoice exists and is the legally meaningful artefact.
    await zoho(`/invoices/${inv.invoice_id}/status/sent`, { method: 'POST' }).catch((e) =>
      console.error(`[zoho.invoice] ${args.source}: mark-sent failed: ${msg(e)}`),
    );

    // On a resume, only pay what is still owed — applying the full amount a
    // second time is books corruption, not a retry.
    const alreadyPaid = resumed && inv.balance === 0;
    if (env.zoho.depositAccountId && !alreadyPaid) {
      await zoho('/customerpayments', {
        method: 'POST',
        body: {
          customer_id: contactId,
          payment_mode: 'other',
          amount: minorToMajor(split.grossMinor),
          date: todayInIST(),
          reference_number: args.providerPaymentId ?? args.source,
          description: `Razorpay ${args.providerPaymentId ?? args.source}`,
          account_id: env.zoho.depositAccountId,
          invoices: [{ invoice_id: inv.invoice_id, amount_applied: minorToMajor(split.grossMinor) }],
        },
      }).catch((e) =>
        console.error(`[zoho.invoice] ${args.source}: payment record failed: ${msg(e)}`),
      );
    }

    if (profile?.email) {
      await zoho(`/invoices/${inv.invoice_id}/email`, {
        method: 'POST',
        body: { to_mail_ids: [profile.email], subject: `Your Sociafy invoice ${inv.invoice_number ?? ''}`.trim() },
      }).catch((e) => console.error(`[zoho.invoice] ${args.source}: email failed: ${msg(e)}`));
    }

    await db()
      .update(invoices)
      .set({
        status: 'issued',
        zohoInvoiceId: inv.invoice_id,
        zohoInvoiceNumber: inv.invoice_number ?? null,
        zohoInvoiceUrl: inv.invoice_url ?? null,
        // Prefer Zoho's own arithmetic once we have it.
        taxableMinor: majorToMinor(inv.sub_total) ?? split.taxableMinor,
        taxMinor: majorToMinor(inv.tax_total) ?? split.taxMinor,
        taxRatePct: isExport ? 0 : GST_RATE_PCT,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, rowId));

    return { ok: true, invoiceNumber: inv.invoice_number ?? null };
  } catch (e) {
    return fail(msg(e));
  }
}

type ZohoInvoice = {
  invoice_id?: string;
  invoice_number?: string;
  invoice_url?: string;
  sub_total?: number;
  tax_total?: number;
  balance?: number;
};

/**
 * Create-or-update the user's Zoho Books contact from their profile, and
 * remember its id. Called on every invoice so a customer who adds their GSTIN
 * after their first payment has it on the next one.
 */
export async function ensureZohoContact(userId: string): Promise<string> {
  const [p] = await db()
    .select({
      id: profiles.id,
      email: profiles.email,
      displayName: profiles.displayName,
      legalName: profiles.legalName,
      gstin: profiles.gstin,
      billingAddress: profiles.billingAddress,
      placeOfSupply: profiles.placeOfSupply,
      billingCountry: profiles.billingCountry,
      zohoContactId: profiles.zohoContactId,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (!p) throw new Error(`no profile for ${userId}`);

  const addr = (p.billingAddress ?? {}) as BillingAddress;
  const country = p.billingCountry ?? addr.country ?? 'IN';
  const isIndia = country === 'IN';
  const gstin = p.gstin?.trim().toUpperCase() || null;
  const stateCode = p.placeOfSupply ?? stateCodeFromGstin(gstin);

  const body: Record<string, unknown> = {
    contact_name: (p.legalName || p.displayName || p.email || userId).slice(0, 200),
    company_name: p.legalName ?? undefined,
    contact_type: 'customer',
    currency_code: 'INR',
    gst_treatment: !isIndia ? 'overseas' : gstin ? 'business_gst' : 'consumer',
    ...(gstin && isIndia ? { gst_no: gstin } : {}),
    // Zoho rejects place_of_supply on overseas contacts — it is a domestic concept.
    ...(isIndia ? { place_of_supply: zohoStateCode(stateCode) ?? HOME_STATE_ZOHO } : {}),
    billing_address: {
      address: addr.line1 ?? '',
      street2: addr.line2 ?? '',
      city: addr.city ?? '',
      state: addr.state ?? '',
      zip: addr.postalCode ?? '',
      country_code: country,
    },
    ...(p.email
      ? { contact_persons: [{ email: p.email, first_name: p.displayName ?? '', is_primary_contact: true }] }
      : {}),
    notes: `sociafy_user_id: ${userId}`,
  };

  if (p.zohoContactId) {
    // Refresh the GST details, but a rename/GSTIN clash must not block the
    // invoice — the contact already exists and that is what we need.
    await zoho(`/contacts/${p.zohoContactId}`, { method: 'PUT', body }).catch((e) =>
      console.error(`[zoho.invoice] contact update failed for ${userId}: ${msg(e)}`),
    );
    return p.zohoContactId;
  }

  const res = await zoho<{ contact: { contact_id?: string } }>('/contacts', { method: 'POST', body });
  const contactId = res.contact?.contact_id;
  if (!contactId) throw new Error('zoho returned no contact_id');

  await db()
    .update(profiles)
    .set({ zohoContactId: contactId, updatedAt: new Date() })
    .where(eq(profiles.id, userId));
  return contactId;
}

/**
 * Retry every invoice a Zoho outage (or a missing env var) left behind.
 * Run hourly: `node --import tsx scripts/cron-run.mjs reissue-invoices`.
 */
export async function reissueFailedInvoices(): Promise<{ retried: number; issued: number; failed: number }> {
  if (isStubMode.database()) return { retried: 0, issued: 0, failed: 0 };

  const stuck = await db()
    .select()
    .from(invoices)
    .where(
      and(
        or(eq(invoices.status, 'failed'), eq(invoices.status, 'pending')),
        lt(invoices.attempts, MAX_ATTEMPTS),
        // Give an in-flight 'pending' row time to finish before stealing it.
        lt(invoices.updatedAt, new Date(Date.now() - 10 * 60_000)),
      ),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(50);

  let issued = 0;
  let failed = 0;
  for (const row of stuck) {
    const meta = (row.meta ?? {}) as { description?: string };
    const r = await raise(
      row.id,
      {
        userId: row.userId,
        kind: row.kind,
        source: row.source,
        grossMinor: row.grossMinor,
        description: meta.description ?? 'Sociafy',
        providerPaymentId: row.providerPaymentId ?? undefined,
      },
      splitInclusive(row.grossMinor),
    );
    if (r.ok) issued++;
    else failed++;
  }
  return { retried: stuck.length, issued, failed };
}

async function attemptsOf(rowId: string): Promise<number> {
  const [r] = await db().select({ attempts: invoices.attempts }).from(invoices).where(eq(invoices.id, rowId)).limit(1);
  return r?.attempts ?? 0;
}

/** Zoho's org timezone is IST; a UTC date rolls over 5.5h early and can date
 *  an invoice into the previous financial year on 1 April. */
const todayInIST = (): string =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const majorToMinor = (major: number | undefined): number | null =>
  typeof major === 'number' ? Math.round(major * 100) : null;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
