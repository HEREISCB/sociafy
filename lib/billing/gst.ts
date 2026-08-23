/**
 * Indian GST primitives — state codes, GSTIN validation, inclusive-tax split.
 *
 * PRICING IS TAX-INCLUSIVE. ₹2,999 is what Razorpay charges and what the
 * invoice totals to; the 18% GST is backed OUT of that figure, not added on
 * top. That keeps the amount on the card, the amount in the ledger, and the
 * amount on the invoice identical — the alternative (exclusive pricing) means
 * changing every price in pricing.ts and every plan in the Razorpay dashboard.
 *
 * Zoho Books does the actual CGST/SGST-vs-IGST split from the contact's
 * place_of_supply against the org's own state. We compute the same numbers
 * locally only so a row in `invoices` is meaningful even when Zoho is down.
 */

/** GST rate on SaaS / OIDAR services (SAC 998314). */
export const GST_RATE_PCT = 18;

/**
 * GST state codes → [name, Zoho Books two-letter code].
 * The numeric key is the first two digits of a GSTIN; Zoho's API wants the
 * letter form for `place_of_supply`.
 */
export const GST_STATES: Record<string, { name: string; zoho: string }> = {
  '01': { name: 'Jammu and Kashmir', zoho: 'JK' },
  '02': { name: 'Himachal Pradesh', zoho: 'HP' },
  '03': { name: 'Punjab', zoho: 'PB' },
  '04': { name: 'Chandigarh', zoho: 'CH' },
  '05': { name: 'Uttarakhand', zoho: 'UK' },
  '06': { name: 'Haryana', zoho: 'HR' },
  '07': { name: 'Delhi', zoho: 'DL' },
  '08': { name: 'Rajasthan', zoho: 'RJ' },
  '09': { name: 'Uttar Pradesh', zoho: 'UP' },
  '10': { name: 'Bihar', zoho: 'BR' },
  '11': { name: 'Sikkim', zoho: 'SK' },
  '12': { name: 'Arunachal Pradesh', zoho: 'AR' },
  '13': { name: 'Nagaland', zoho: 'NL' },
  '14': { name: 'Manipur', zoho: 'MN' },
  '15': { name: 'Mizoram', zoho: 'MZ' },
  '16': { name: 'Tripura', zoho: 'TR' },
  '17': { name: 'Meghalaya', zoho: 'ML' },
  '18': { name: 'Assam', zoho: 'AS' },
  '19': { name: 'West Bengal', zoho: 'WB' },
  '20': { name: 'Jharkhand', zoho: 'JH' },
  '21': { name: 'Odisha', zoho: 'OD' },
  '22': { name: 'Chhattisgarh', zoho: 'CG' },
  '23': { name: 'Madhya Pradesh', zoho: 'MP' },
  '24': { name: 'Gujarat', zoho: 'GJ' },
  '26': { name: 'Dadra and Nagar Haveli and Daman and Diu', zoho: 'DD' },
  '27': { name: 'Maharashtra', zoho: 'MH' },
  '29': { name: 'Karnataka', zoho: 'KA' },
  '30': { name: 'Goa', zoho: 'GA' },
  '31': { name: 'Lakshadweep', zoho: 'LD' },
  '32': { name: 'Kerala', zoho: 'KL' },
  '33': { name: 'Tamil Nadu', zoho: 'TN' },
  '34': { name: 'Puducherry', zoho: 'PY' },
  '35': { name: 'Andaman and Nicobar Islands', zoho: 'AN' },
  '36': { name: 'Telangana', zoho: 'TS' },
  '37': { name: 'Andhra Pradesh', zoho: 'AP' },
  '38': { name: 'Ladakh', zoho: 'LA' },
  '97': { name: 'Other Territory', zoho: 'OT' },
};

/** For the dropdown. Sorted by name, not by code. */
export const GST_STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([code, s]) => ({ code, ...s }))
  .sort((a, b) => a.name.localeCompare(b.name));

const GSTIN_RX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Full GSTIN check: shape, a real state code, and the mod-36 checksum.
 *
 * The checksum is the point. Shape alone accepts any transposed digit, and a
 * GSTIN typo does not fail loudly — it produces a filed invoice naming a
 * business that does not exist, which is the customer's problem to unwind
 * with their accountant months later.
 */
export function isValidGstin(gstin: string): boolean {
  const v = gstin.trim().toUpperCase();
  if (!GSTIN_RX.test(v)) return false;
  if (!GST_STATES[v.slice(0, 2)]) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARSET.indexOf(v[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36] === v[14];
}

/** First two digits of a GSTIN, or null if it isn't one. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const code = gstin.trim().slice(0, 2);
  return GST_STATES[code] ? code : null;
}

/** Numeric GST state code → the two-letter form Zoho Books expects. */
export function zohoStateCode(stateCode: string | null | undefined): string | null {
  return stateCode ? GST_STATES[stateCode]?.zoho ?? null : null;
}

/**
 * Back the tax out of a tax-INCLUSIVE amount, in minor units (paise).
 *
 * taxable = round(gross * 100 / (100 + rate)); tax is the remainder, so
 * taxable + tax === gross exactly and the invoice can never be off by a paisa
 * from what the card was charged.
 */
export function splitInclusive(
  grossMinor: number,
  ratePct: number = GST_RATE_PCT,
): { grossMinor: number; taxableMinor: number; taxMinor: number; ratePct: number } {
  const taxableMinor = Math.round((grossMinor * 100) / (100 + ratePct));
  return { grossMinor, taxableMinor, taxMinor: grossMinor - taxableMinor, ratePct };
}

/** Paise → the major-unit number Zoho wants on a line item (2dp). */
export const minorToMajor = (minor: number): number => Math.round(minor) / 100;
