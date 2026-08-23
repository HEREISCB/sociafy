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

import React, { useEffect, useState } from 'react';
import { apiPatch, useApi } from '../../lib/ui/fetcher';
import { GST_STATE_OPTIONS, isValidGstin, stateCodeFromGstin } from '../../lib/billing/gst';
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
    if (value.gstin && !isValidGstin(value.gstin)) return 'That GSTIN doesn’t look right — check for a typo.';
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
      return `Couldn't save your billing details: ${e instanceof Error ? e.message.slice(0, 140) : 'unknown error'}`;
    } finally {
      setSaving(false);
    }
  };

  return { value, set, setAddress, save, saving, loaded, validate };
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

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--mono)',
  color: 'var(--ink-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  border: '1px solid var(--line-2)',
  borderRadius: 10,
  fontSize: 14,
  background: 'var(--bg-elev)',
  color: 'var(--ink)',
  outline: 'none',
  fontFamily: 'inherit',
};

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={labelStyle}>
          Registered legal name{' '}
          <span style={{ textTransform: 'none', color: 'var(--ink-4)', fontWeight: 400 }}>
            · exactly as on your GST certificate, if you have one
          </span>
        </div>
        <input
          type="text"
          value={value.legalName}
          onChange={(e) => set('legalName', e.target.value)}
          placeholder="Acme Technologies Private Limited"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={labelStyle}>Country</div>
          <select
            value={(a.country ?? value.billingCountry ?? 'IN').toUpperCase()}
            onChange={(e) => setAddress('country', e.target.value)}
            style={inputStyle}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <div style={labelStyle}>PAN <span style={{ textTransform: 'none', color: 'var(--ink-4)', fontWeight: 400 }}>· optional</span></div>
          <input
            type="text"
            value={value.pan}
            onChange={(e) => set('pan', e.target.value.toUpperCase())}
            maxLength={10}
            placeholder="AAAPZ1234C"
            style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
          />
        </div>
      </div>

      {isIndia && (
        <div>
          <div style={labelStyle}>
            GSTIN{' '}
            <span style={{ textTransform: 'none', color: 'var(--ink-4)', fontWeight: 400 }}>
              · leave blank if you aren&apos;t GST-registered
            </span>
          </div>
          <input
            type="text"
            value={value.gstin}
            onChange={(e) => set('gstin', e.target.value.toUpperCase())}
            maxLength={15}
            placeholder="27AAPFU0939F1ZV"
            aria-invalid={gstinBad}
            style={{
              ...inputStyle,
              fontFamily: 'var(--mono)',
              borderColor: gstinBad ? 'var(--bad)' : 'var(--line-2)',
            }}
          />
          <div style={{ fontSize: 11, marginTop: 4, color: gstinBad ? 'var(--bad)' : 'var(--ink-4)' }}>
            {gstinBad
              ? 'Check this — the format or checksum is off.'
              : stateFromGstin
                ? `Registered in ${GST_STATE_OPTIONS.find((s) => s.code === stateFromGstin)?.name}. We'll charge GST accordingly.`
                : 'With a GSTIN on file we raise a B2B tax invoice you can claim input credit on.'}
          </div>
        </div>
      )}

      <div>
        <div style={labelStyle}>Billing address</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="text"
            value={a.line1 ?? ''}
            onChange={(e) => setAddress('line1', e.target.value)}
            placeholder="Address line 1"
            style={inputStyle}
          />
          <input
            type="text"
            value={a.line2 ?? ''}
            onChange={(e) => setAddress('line2', e.target.value)}
            placeholder="Address line 2 (optional)"
            style={inputStyle}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <input
              type="text"
              value={a.city ?? ''}
              onChange={(e) => setAddress('city', e.target.value)}
              placeholder="City"
              style={inputStyle}
            />
            <input
              type="text"
              value={a.postalCode ?? ''}
              onChange={(e) => setAddress('postalCode', e.target.value)}
              placeholder="PIN / ZIP"
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          {isIndia ? (
            <select
              value={stateFromGstin ?? value.placeOfSupply}
              disabled={!!stateFromGstin}
              onChange={(e) => {
                const code = e.target.value;
                set('placeOfSupply', code);
                setAddress('state', GST_STATE_OPTIONS.find((s) => s.code === code)?.name ?? '');
              }}
              style={{ ...inputStyle, opacity: stateFromGstin ? 0.65 : 1 }}
            >
              <option value="">State (place of supply)…</option>
              {GST_STATE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={a.state ?? ''}
              onChange={(e) => setAddress('state', e.target.value)}
              placeholder="State / province / country"
              style={inputStyle}
            />
          )}
        </div>
      </div>
    </div>
  );
}
