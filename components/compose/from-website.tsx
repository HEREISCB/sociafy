'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThumbImg } from '../thumb-img';
import { apiPost, friendlyApiError } from '../../lib/ui/fetcher';
import { priceForCompose } from '../../lib/credits/pricing';
import type { Platform } from '../../lib/db/schema';
import type { MediaItem } from './attachments';

type Product = { id: string; name: string; pitch: string; facts: string[]; imageUrls: string[]; postText: string };
type Found = { site: { name: string; summary: string }; products: Product[] };
type Estimate = { key: string; perProduct: Record<string, number> };
type LibraryRow = { id: string; publicUrl: string; mimeType: string; label: string | null };

const FIND_COST = priceForCompose({ withTools: false }).credits;

/** apiPost throws "<status>: <body>". */
function errBody(e: unknown): { status: number; body: Record<string, unknown> } | null {
  const m = (e instanceof Error ? e.message : '').match(/^(\d{3}):\s*([\s\S]*)$/);
  if (!m) return null;
  try { return { status: Number(m[1]), body: JSON.parse(m[2]) }; } catch { return { status: Number(m[1]), body: {} }; }
}
const hintOf = (e: unknown) => {
  const h = errBody(e)?.body.hint;
  return typeof h === 'string' ? h : friendlyApiError(e);
};

/**
 * Video tab: paste a product/company website, get its products, and make one
 * video post per product (each lands on Home as its own draft, rendering).
 * Or drop one product's caption + photos into the post box to edit by hand.
 */
export function FromWebsite({ platforms, onUse, onCredits, onCharged }: {
  /** Where the new posts go (the composer's platform picks that take video). */
  platforms: Platform[];
  onUse: (text: string, media: MediaItem[]) => void;
  onCredits: (e: { balance: number; needed: number }) => void;
  onCharged: () => void;
}) {
  const [url, setUrl] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'find' | 'make' | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ count: number; failed: { name: string; hint?: string }[] } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  // One dry run per (products, platforms): prices every product; the total is summed from what's checked.
  const estKey = found ? JSON.stringify([found.products.map((p) => p.id + p.postText), platforms]) : null;
  useEffect(() => {
    if (!found || !estKey) return;
    let live = true;
    apiPost<{ plans: { estimatedCredits: number }[] }>('/api/media/from-url/videos', {
      products: found.products.map(({ name, postText, imageUrls }) => ({ name, postText, imageUrls })), platforms, dryRun: true,
    }).then(
      (r) => { if (live) setEstimate({ key: estKey, perProduct: Object.fromEntries(found.products.map((p, i) => [p.id, r.plans[i]?.estimatedCredits ?? 0])) }); },
      // No price → the button says so; the real request still checks the balance.
      () => { if (live) setEstimate({ key: estKey, perProduct: {} }); },
    );
    return () => { live = false; };
  }, [estKey]); // eslint-disable-line react-hooks/exhaustive-deps -- estKey covers found + platforms

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy('find'); setError(null); setMade(null);
    try {
      const r = await apiPost<Found>('/api/media/from-url', { url: url.trim() });
      setFound(r);
      setChecked(new Set(r.products.map((p) => p.id)));
      onCharged();
    } catch (err) {
      const b = errBody(err);
      if (b?.status === 402) onCredits({ balance: Number(b.body.balance ?? 0), needed: Number(b.body.needed ?? 0) });
      else setError(hintOf(err));
    } finally {
      setBusy(null);
    }
  };

  const picked = found?.products.filter((p) => checked.has(p.id)) ?? [];
  const priced = estimate?.key === estKey ? estimate.perProduct : null;
  const total = priced && picked.every((p) => priced[p.id] != null) ? picked.reduce((s, p) => s + priced[p.id], 0) : null;

  const make = async () => {
    if (!picked.length || busy) return;
    setBusy('make'); setError(null);
    try {
      const r = await apiPost<{ drafts: unknown[]; failed: { name: string; hint?: string }[] }>('/api/media/from-url/videos', {
        products: picked.map(({ name, postText, imageUrls }) => ({ name, postText, imageUrls })),
        platforms,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, { timeoutMs: 300_000 });
      setMade({ count: r.drafts.length, failed: r.failed });
      setFound(null);
      onCharged();
    } catch (err) {
      const b = errBody(err);
      if (b?.status === 402) onCredits({ balance: Number(b.body.balance ?? 0), needed: Number(b.body.needed ?? 0) });
      else setError(hintOf(err));
    } finally {
      setBusy(null);
    }
  };

  const use = async (p: Product) => {
    if (busy) return;
    setBusy(p.id); setError(null);
    let media: MediaItem[] = [];
    try {
      if (p.imageUrls.length) {
        const r = await apiPost<{ items: LibraryRow[] }>('/api/media/from-url/import', { imageUrls: p.imageUrls, label: p.name });
        media = r.items.map((m) => ({ id: m.id, url: m.publicUrl, mimeType: m.mimeType, label: m.label ?? p.name }));
      }
    } catch (err) {
      // The caption is still worth having; say the photos didn't come.
      setError(`Added the caption, but not the photos: ${hintOf(err)}`);
    } finally {
      setBusy(null);
    }
    onUse(p.postText, media);
  };

  const toggle = (id: string) => setChecked((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="compose-media-panel fromsite">
      <form className="fromsite-row" onSubmit={find}>
        <label className="compose-label" htmlFor="fromsite-url">From a website</label>
        <input
          id="fromsite-url" className="input" type="text" inputMode="url" autoComplete="url" spellCheck={false}
          placeholder="https://yourshop.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy === 'find'}
        />
        <button type="submit" className="btn sm" disabled={!url.trim() || busy !== null}>
          {busy === 'find' ? 'Reading the site…' : 'Find products'} <span className="compose-cost">{FIND_COST} cr</span>
        </button>
      </form>
      {!found && !made && <p className="compose-note">Paste your product or company site. We find each product and make a separate video post for each one.</p>}

      {error && <p className="compose-note compose-error" role="alert">{error}</p>}

      {found && (
        <>
          <p className="compose-note">
            {found.products.length === 1 ? 'Found 1 product' : `Found ${found.products.length} products`}{found.site.name ? ` on ${found.site.name}` : ''}. Each one you keep becomes its own post with its own video.
          </p>
          <ul className="fromsite-list">
            {found.products.map((p) => (
              <li key={p.id} className="fromsite-card">
                <label className="fromsite-pick">
                  <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} disabled={busy === 'make'} />
                  {p.imageUrls[0] ? <span className="fromsite-thumb"><ThumbImg src={p.imageUrls[0]} alt="" size={48} /></span> : <span className="fromsite-thumb" aria-hidden="true" />}
                  <span className="fromsite-text">
                    <span className="fromsite-name">{p.name}</span>
                    {p.pitch && <span className="fromsite-pitch">{p.pitch}</span>}
                  </span>
                </label>
                <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => use(p)}>
                  {busy === p.id ? 'Adding…' : 'Use in post box'}
                </button>
              </li>
            ))}
          </ul>
          {!platforms.length && <p className="compose-note">Pick at least one platform below that takes video.</p>}
          <div className="row">
            <button type="button" className="btn primary" disabled={!picked.length || !platforms.length || busy !== null} onClick={make}>
              {busy === 'make' ? 'Starting videos…' : `Make ${picked.length} ${picked.length === 1 ? 'video' : 'videos'}`}
              {total != null ? <span className="compose-cost">{total} cr</span> : picked.length > 0 && <span className="compose-cost">pricing…</span>}
            </button>
          </div>
        </>
      )}

      {made && (
        <p className="compose-note" role="status">
          {made.count === 1 ? '1 video is rendering' : `${made.count} videos are rendering`} — they&rsquo;ll appear on <Link href="/dashboard">Home</Link> for review.
          {made.failed.map((f) => ` ${f.name} didn’t start: ${f.hint ?? 'try it again.'}`).join('')}
        </p>
      )}
    </div>
  );
}
