'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ThumbImg } from '../thumb-img';
import { apiPost, friendlyApiError } from '../../lib/ui/fetcher';
import { priceForCompose } from '../../lib/credits/pricing';
import type { Platform } from '../../lib/db/schema';
import type { MediaItem } from './attachments';
import { pollJob } from './generate';

type Product = { id: string; name: string; pitch: string; facts: string[]; imageUrls: string[]; postText: string };
type Found = { site: { name: string; summary: string }; products: Product[] };
type Estimate = { key: string; perProduct: Record<string, number> };
type Mode = 'products' | 'site' | 'content';
/** What one video is about, per mode: tab label, button, intro, and the found-list noun. */
const MODES: Record<Mode, { tab: string; find: string; intro: string; one: string; many: string }> = {
  products: { tab: 'Each product', find: 'Find products', intro: 'We find each product on the site and make a separate video post for each one.', one: 'product', many: 'products' },
  site: { tab: 'The whole website', find: 'Plan the video', intro: 'One video about the whole site: what it is, who it’s for and why it matters.', one: 'video idea', many: 'video ideas' },
  content: { tab: 'Pages & topics', find: 'Find topics', intro: 'We find the sections, features and articles on the site and make a video post for each one.', one: 'topic', many: 'topics' },
};
type LibraryRow = { id: string; publicUrl: string; mimeType: string; label: string | null };

const FIND_COST = priceForCompose({ withTools: false }).credits;

type MadeDraft = { id: string; name: string; videoJobId: string | null; estimatedCredits?: number };

/** One post being made from the site: live render status, then the video right here, then open it to schedule/post. */
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (t: Date) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
type Sent = { kind: 'scheduled'; at: Date; platforms: string[] } | { kind: 'posted'; ok: string[]; failed: string[] };

function RenderCard({ d, platforms }: { d: MadeDraft; platforms: Platform[] }) {
  // Empty on purpose: the user decides when this post goes out.
  const [when, setWhen] = useState('');
  const [sending, setSending] = useState<null | 'schedule' | 'post'>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [state, setState] = useState<{ phase: 'rendering' } | { phase: 'done'; url: string; poster?: string } | { phase: 'failed' }>(
    d.videoJobId ? { phase: 'rendering' } : { phase: 'failed' },
  );
  useEffect(() => {
    if (!d.videoJobId) return;
    let live = true;
    pollJob(`/api/media/video-job/${d.videoJobId}`, 30 * 60_000, [5_000, 1_000, 10_000]).then((out) => {
      if (!live) return;
      setState('asset' in out && out.asset ? { phase: 'done', url: out.asset.publicUrl, poster: out.asset.posterUrl } : { phase: 'failed' });
    });
    return () => { live = false; };
  }, [d.videoJobId]);

  const ready = state.phase === 'done' && platforms.length > 0;
  const schedule = async () => {
    const at = new Date(when);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) { setSendError('Pick a time in the future.'); return; }
    setSending('schedule'); setSendError(null);
    try {
      const r = await apiPost<{ scheduled: { platform: string }[] }>('/api/schedule', { draftId: d.id, scheduledAt: at.toISOString(), platforms });
      setSent({ kind: 'scheduled', at, platforms: r.scheduled.map((x) => x.platform) });
    } catch (e) { setSendError(friendlyApiError(e)); } finally { setSending(null); }
  };
  const postNow = async () => {
    setSending('post'); setSendError(null);
    try {
      const r = await apiPost<{ results?: { platform: string; ok: boolean }[] }>('/api/publish', { draftId: d.id, platforms }, { timeoutMs: 180_000 });
      const rows = r.results ?? [];
      setSent({ kind: 'posted', ok: rows.filter((x) => x.ok).map((x) => x.platform), failed: rows.filter((x) => !x.ok).map((x) => x.platform) });
    } catch (e) { setSendError(friendlyApiError(e)); } finally { setSending(null); }
  };
  return (
    <li className="fromsite-card fromsite-made">
      <div className="fromsite-video">
        {state.phase === 'done'
          ? <video src={state.poster ? state.url : `${state.url}#t=0.5`} poster={state.poster} controls playsInline preload="metadata" />
          : <div className={`fromsite-video-wait${state.phase === 'rendering' ? ' sk' : ''}`} role="status">{state.phase === 'rendering' ? 'Making the video… about 2–3 min' : 'The video didn’t render — credits were refunded. The post is saved as text.'}</div>}
      </div>
      <div className="fromsite-made-foot">
        <span className="fromsite-name" title={d.name}>{d.name}</span>
        <Link className="btn ghost sm" href={`/compose?draft=${d.id}`}>Edit</Link>
      </div>
      {sent ? (
        <p className="compose-note" role="status">
          {sent.kind === 'scheduled'
            ? `Scheduled for ${sent.at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} on ${sent.platforms.join(', ')}.`
            : `${sent.ok.length ? `Posted to ${sent.ok.join(', ')}.` : ''}${sent.failed.length ? ` Couldn’t post to ${sent.failed.join(', ')} — open Edit to retry.` : ''}`}
        </p>
      ) : (
        <div className="fromsite-when">
          <label className="sr-only" htmlFor={`when-${d.id}`}>When to post {d.name}</label>
          <input id={`when-${d.id}`} className="input" type="datetime-local" value={when} min={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} disabled={sending !== null} />
          <div className="row">
            <button type="button" className="btn primary sm" disabled={!ready || !when || sending !== null} onClick={schedule}>{sending === 'schedule' ? 'Scheduling…' : 'Schedule'}</button>
            <button type="button" className="btn ghost sm" disabled={!ready || sending !== null} onClick={postNow}>{sending === 'post' ? 'Posting…' : 'Post now'}</button>
          </div>
          {!ready && <p className="compose-note">{state.phase === 'rendering' ? 'Pick a time now — Schedule unlocks when the video is ready.' : 'Open Edit to add media or post it as text.'}</p>}
          {ready && !when && <p className="compose-note">Pick a date and time, or post now.</p>}
          {sendError && <p className="compose-note compose-error" role="alert">{sendError}</p>}
        </div>
      )}
    </li>
  );
}

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
export function FromWebsite({ platforms, length, onUse, onCredits, onCharged }: {
  /** Where the new posts go (the composer's platform picks that take video). */
  platforms: Platform[];
  /** Picked video length in seconds (null = Auto). */
  length: number | null;
  onUse: (text: string, media: MediaItem[]) => void;
  onCredits: (e: { balance: number; needed: number }) => void;
  onCharged: () => void;
}) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('products');
  const m = MODES[mode];
  const [found, setFound] = useState<Found | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'find' | 'make' | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ drafts: MadeDraft[]; failed: { name: string; hint?: string }[] } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);

  // One dry run per (products, platforms): prices every product; the total is summed from what's checked.
  const estKey = found ? JSON.stringify([found.products.map((p) => p.id + p.postText), platforms, length]) : null;
  useEffect(() => {
    if (!found || !estKey) return;
    let live = true;
    apiPost<{ plans: { estimatedCredits: number }[] }>('/api/media/from-url/videos', {
      products: found.products.map(({ name, postText, imageUrls }) => ({ name, postText, imageUrls })), platforms, dryRun: true, ...(length ? { durationSec: length } : {}),
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
      const r = await apiPost<Found>('/api/media/from-url', { url: url.trim(), mode });
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
      const r = await apiPost<{ drafts: MadeDraft[]; failed: { name: string; hint?: string }[] }>('/api/media/from-url/videos', {
        products: picked.map(({ name, postText, imageUrls }) => ({ name, postText, imageUrls })),
        platforms,
        ...(length ? { durationSec: length } : {}),
      }, { timeoutMs: 300_000 });
      setMade({ drafts: r.drafts, failed: r.failed });
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

  /** One or several items into the post box as ONE post: a single item keeps its caption; several become one combined brief. */
  const use = async (items: Product[], key: string) => {
    if (busy || !items.length) return;
    setBusy(key); setError(null);
    const one = items.length === 1;
    const text = one ? items[0].postText : [
      `${found?.site.name ? `${found.site.name}: ` : ''}${items.map((p) => p.name).join(', ')}`,
      ...items.map((p) => `• ${p.name}${p.pitch ? ` — ${p.pitch}` : ''}${p.facts.length ? ` (${p.facts.slice(0, 3).join('; ')})` : ''}`),
    ].join('\n\n').slice(0, 4_000);
    // A single item brings all its photos; several bring each one's best photo.
    const urls = [...new Set(one ? items[0].imageUrls : items.flatMap((p) => p.imageUrls.slice(0, 1)))].slice(0, 12);
    let media: MediaItem[] = [];
    try {
      for (let i = 0; i < urls.length; i += 4) {
        const r = await apiPost<{ items: LibraryRow[] }>('/api/media/from-url/import', { imageUrls: urls.slice(i, i + 4), label: one ? items[0].name : found?.site.name || 'Website' });
        media = media.concat(r.items.map((m) => ({ id: m.id, url: m.publicUrl, mimeType: m.mimeType, label: m.label ?? items[0].name })));
      }
    } catch (err) {
      // The text is still worth having; say the photos didn't (all) come.
      setError(`Added the text, but not every photo: ${hintOf(err)}`);
    } finally {
      setBusy(null);
    }
    onUse(text, media);
  };

  const toggle = (id: string) => setChecked((cur) => {
    const n = new Set(cur);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="compose-media-panel fromsite">
      <div className="mode-switch" role="radiogroup" aria-label="Make videos about">
        {(Object.keys(MODES) as Mode[]).map((id) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={`opt${mode === id ? ' active' : ''}`} disabled={busy !== null} onClick={() => { setMode(id); setFound(null); setMade(null); setError(null); }}>
            {MODES[id].tab}
          </button>
        ))}
      </div>
      <form className="fromsite-row" onSubmit={find}>
        <label className="compose-label" htmlFor="fromsite-url">From a website</label>
        <input
          id="fromsite-url" className="input" type="text" inputMode="url" autoComplete="url" spellCheck={false}
          placeholder="https://yourshop.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy === 'find'}
        />
        <button type="submit" className="btn sm" disabled={!url.trim() || busy !== null}>
          {busy === 'find' ? 'Reading the site…' : m.find} <span className="compose-cost">{FIND_COST} cr</span>
        </button>
      </form>
      {!found && !made && <p className="compose-note">Paste a website. {m.intro}</p>}

      {error && <p className="compose-note compose-error" role="alert">{error}</p>}

      {found && (
        <>
          <p className="compose-note">
            {found.products.length === 1 ? `Found 1 ${m.one}` : `Found ${found.products.length} ${m.many}`}{found.site.name ? ` on ${found.site.name}` : ''}. Tick the ones you want: make a separate video for each, or put them together in the post box as one post.
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
                <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => use([p], p.id)}>
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
            <button type="button" className="btn sm" disabled={!picked.length || busy !== null} onClick={() => use(picked, 'many')}>
              {busy === 'many' ? 'Adding…' : `Use ${picked.length} in post box`}
            </button>
          </div>
        </>
      )}

      {made && (
        <>
          <p className="compose-note" role="status">
            {made.drafts.length === 1 ? 'Your video is being made below.' : `Your ${made.drafts.length} videos are being made below — each is its own post.`} Pick when each one posts — nothing goes out until you do. They’re saved, so nothing is lost if you leave.
            {made.failed.map((f) => ` ${f.name} didn’t start: ${f.hint ?? 'try it again.'}`).join('')}
          </p>
          <ul className="fromsite-made-grid">
            {made.drafts.map((d) => <RenderCard key={d.id} d={d} platforms={platforms} />)}
          </ul>
        </>
      )}
    </div>
  );
}
