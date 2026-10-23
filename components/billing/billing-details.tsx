'use client';

/**
 * The company identity that goes on a GST invoice, shared by onboarding's
 * Brand step and /billing.
 *
 * Split into a hook (owns fetch + save) and dumb fields, because the two
 * callers save at different moments: onboarding folds the save into its
 * "Continue" button, /billing has its own Save. Neither should re-implement
 * the form.
 */

import { useEffect, useState } from 'react';
import { apiPatch, useApi } from '../../lib/ui/fetcher';
import { GST_STATE_OPTIONS, gstTreatment, isValidGstin, stateCodeFromGstin } from '../../lib/billing/gst';
import type { BillingAddress } from '../../lib/db/schema';

export type BillingDetailsValue = {
  legalName: string;
  gstin: string;
  pan: string;
  billingAddress: BillingAddress;
  placeOfSupply: string;
  billingCountry: string;
};

const EMPTY: BillingDetailsValue = {
  legalName: '',
  gstin: '',
  pan: '',
  billingAddress: {},
  placeOfSupply: '',
  billingCountry: 'IN',
};

export function useBillingDetails() {
  const { data, mutate } = useApi<BillingDetailsValue>('/api/billing/details');
  const [value, setValue] = useState<BillingDetailsValue>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed once. Re-seeding on every revalidation would stomp on whatever the
  // user is mid-way through typing.
  useEffect(() => {
    if (data && !loaded) {
      setValue({ ...EMPTY, ...data, billingAddress: data.billingAddress ?? {} });
      setLoaded(true);
    }
  }, [data, loaded]);

  const set = <K extends keyof BillingDetailsValue>(key: K, v: BillingDetailsValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }));

  const setAddress = (key: keyof BillingAddress, v: string) =>
    setValue((prev) => ({ ...prev, billingAddress: { ...prev.billingAddress, [key]: v } }));

  /** Client-side mirror of billingDetailsSchema — the server re-checks. */
  const validate = (): string | null => {
    if (value.gstin && !isValidGstin(value.gstin)) return 'That GSTIN doesn’t look right. Check for a typo.';
    if (value.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value.pan.toUpperCase())) return 'That PAN doesn’t look right.';
    return null;
  };

  /**
   * Persist. Returns null on success or a message to show. Never throws, so a
   * caller can fold it into a multi-step save without a try/catch.
   */
  const save = async (): Promise<string | null> => {
    const invalid = validate();
    if (invalid) return invalid;
    setSaving(true);
    try {
      await apiPatch('/api/billing/details', {
        legalName: value.legalName,
        gstin: value.gstin.toUpperCase(),
        pan: value.pan.toUpperCase(),
        billingAddress: value.billingAddress,
        placeOfSupply: value.placeOfSupply,
      });
      await mutate();
      return null;
    } catch (e) {
      return `Couldn’t save your billing details: ${e instanceof Error ? e.message.slice(0, 140) : 'unknown error'}`;
    } finally {
      setSaving(false);
    }
  };

  /** Drop unsaved edits: re-seed from what the server has. */
  const reset = () => setLoaded(false);

  return { value, set, setAddress, save, saving, loaded, validate, reset };
}

/** Read mode: what the next invoice will say, and which tax line it carries. */
export function BillingDetailsSummary({ value }: { value: BillingDetailsValue }) {
  const a = value.billingAddress;
  const country = (a.country ?? value.billingCountry ?? 'IN').toUpperCase();
  const address = [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(' '), a.state, country === 'IN' ? '' : COUNTRIES.find((c) => c.code === country)?.name]
    .filter(Boolean).join(', ');
  const tax = gstTreatment({ country, placeOfSupply: value.placeOfSupply, gstin: value.gstin });
  return (
    <>
      <div className="acct-taxsum">
        <div><span className="acct-label">Legal name</span><b>{value.legalName || 'Not set: invoices use your account name'}</b></div>
        <div><span className="acct-label">GSTIN</span><b className={value.gstin ? 'mono' : ''}>{value.gstin || 'None (B2C invoice)'}</b></div>
        <div><span className="acct-label">Address</span><b>{address || 'Not set'}</b></div>
      </div>
      <p className="acct-note" style={{ marginTop: 12 }}>
        {tax.split === 'export'
          ? 'No GST: billed as an export of services.'
          : tax.split === 'igst'
            ? `${tax.label}: you’re in ${tax.stateName}, we bill from Uttar Pradesh.`
            : `${tax.label}: ${tax.stateName ? 'you’re in Uttar Pradesh, like us' : 'no state on record, so we bill as Uttar Pradesh'}.`}
        {' '}Invoices already issued can’t be changed.
      </p>
    </>
  );
}

/**
 * ISO 3166-1 alpha-2, India first. Deliberately short: the only branch that
 * matters is India (GST) vs not-India (export of services, zero-rated), and
 * these are the markets we actually bill. Add a row when a customer turns up
 * from somewhere else — a full 249-entry table earns nothing here.
 */
const COUNTRIES = [
  { code: 'IN', name: 'India' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'AU', name: 'Australia' },
  { code: 'CA', name: 'Canada' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IE', name: 'Ireland' },
  { code: 'JP', name: 'Japan' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'PH', name: 'Philippines' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SG', name: 'Singapore' },
  { code: 'US', name: 'United States' },
  { code: 'ZA', name: 'South Africa' },
];

export function BillingDetailsFields({
  value,
  set,
  setAddress,
}: {
  value: BillingDetailsValue;
  set: <K extends keyof BillingDetailsValue>(key: K, v: BillingDetailsValue[K]) => void;
  setAddress: (key: keyof BillingAddress, v: string) => void;
}) {
  const isIndia = (value.billingAddress.country ?? value.billingCountry ?? 'IN').toUpperCase() === 'IN';
  const gstinTouched = value.gstin.length > 0;
  const gstinBad = gstinTouched && !isValidGstin(value.gstin);
  // A GSTIN names its own state — showing the picker too invites a contradiction.
  const stateFromGstin = stateCodeFromGstin(value.gstin);
  const a = value.billingAddress;

  return (
    <div className="stack">
      <label className="set-field">
        <span className="set-label">Registered legal name</span>
        <input
          className="input"
          type="text"
          value={value.legalName}
          onChange={(e) => set('legalName', e.target.value)}
          placeholder="Third Wave Brew Private Limited"
        />
        <span className="set-hint">Exactly as on your GST certificate, if you have one.</span>
      </label>

      <div className="set-grid-2">
        <label className="set-field">
          <span className="set-label">Country</span>
          <select
            className="input"
            value={(a.country ?? value.billingCountry ?? 'IN').toUpperCase()}
            onChange={(e) => setAddress('country', e.target.value)}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="set-field">
          <span className="set-label">PAN <span className="opt">optional</span></span>
          <input
            className="input mono"
            type="text"
            value={value.pan}
            onChange={(e) => set('pan', e.target.value.toUpperCase())}
            maxLength={10}
            placeholder="AAAPZ1234C"
          />
        </label>
      </div>

      {isIndia && (
        <label className="set-field">
          <span className="set-label">GSTIN <span className="opt">optional</span></span>
          <input
            className="input mono"
            type="text"
            value={value.gstin}
            onChange={(e) => set('gstin', e.target.value.toUpperCase())}
            maxLength={15}
            placeholder="27AAPFU0939F1ZV"
            aria-invalid={gstinBad}
          />
          <span className={gstinBad ? 'set-hint err' : 'set-hint'}>
            {gstinBad
              ? 'Check this. The format or checksum is off.'
              : stateFromGstin
                ? `Registered in ${GST_STATE_OPTIONS.find((s) => s.code === stateFromGstin)?.name}. We’ll charge GST accordingly.`
                : 'Leave blank if you aren’t GST-registered.'}
          </span>
        </label>
      )}

      <div className="set-field">
        <span className="set-label" id="billing-address-label">Billing address</span>
        <div className="stack" role="group" aria-labelledby="billing-address-label">
          <input
            className="input"
            type="text"
            value={a.line1 ?? ''}
            onChange={(e) => setAddress('line1', e.target.value)}
            placeholder="Address line 1"
            aria-label="Address line 1"
          />
          <input
            className="input"
            type="text"
            value={a.line2 ?? ''}
            onChange={(e) => setAddress('line2', e.target.value)}
            placeholder="Address line 2 (optional)"
            aria-label="Address line 2"
          />
          <div className="set-grid-2">
            <input
              className="input"
              type="text"
              value={a.city ?? ''}
              onChange={(e) => setAddress('city', e.target.value)}
              placeholder="City"
              aria-label="City"
            />
            <input
              className="input mono"
              type="text"
              value={a.postalCode ?? ''}
              onChange={(e) => setAddress('postalCode', e.target.value)}
              placeholder="PIN / ZIP"
              aria-label="PIN or ZIP code"
            />
          </div>
          {isIndia ? (
            <select
              className="input"
              value={stateFromGstin ?? value.placeOfSupply}
              disabled={!!stateFromGstin}
              aria-label="State (place of supply)"
              onChange={(e) => {
                const code = e.target.value;
                set('placeOfSupply', code);
                setAddress('state', GST_STATE_OPTIONS.find((s) => s.code === code)?.name ?? '');
              }}
            >
              <option value="">State (place of supply)…</option>
              {GST_STATE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type="text"
              value={a.state ?? ''}
              onChange={(e) => setAddress('state', e.target.value)}
              placeholder="State / province"
              aria-label="State or province"
            />
          )}
        </div>
      </div>
    </div>
  );
}
