'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import { Icon, Pglyph } from './icons';
import { apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import { postKind, supportsKind, unsupportedReason } from '../lib/platforms/capabilities';
import { priceForCompose } from '../lib/credits/pricing';
import { postMedia } from '../lib/ui/postMedia';
import type { Platform } from '../lib/db/schema';
import { InsufficientCreditsBanner } from './credits';
import { Attachments, MAX_ATTACHED, type MediaItem } from './compose/attachments';
import { genCosts, RenderStatus, useMediaGen } from './compose/generate';
import { ImageOptions, PRESETS, VideoOptions, WritingOptions } from './compose/options';
import { Preview, type VideoSlot } from './compose/preview';
import { AvatarCropModal } from './compose/avatar-crop';
import { MotionEditor } from './compose/motion-editor';
import { SmartVideo } from './compose/smart';
import { FromWebsite } from './compose/from-website';
import { ComposeChat } from './compose/chat';

/** Hard caption limits per platform (mirrors PLATFORM_LIMITS in lib/ai/compose.ts,
 *  which is server-only). */
const LIMIT: Record<Platform, number> = {
  x: 280, linkedin: 3000, instagram: 2200, facebook: 2000, tiktok: 2200, youtube: 5000, reddit: 40000,
};

/**
 * Public failure codes from /api/media/video-job → copy the user can act on.
 * `poll_timeout` is ours: the tab gave up, the job did not. A content refusal
 * must never read as a capacity problem — retrying it unchanged costs credits
 * and fails the same way.
 */
const VIDEO_FAIL_COPY: Record<string, string> = {
  prompt_rejected: 'The prompt was rejected by the content filter — reword it before retrying, because the same prompt will be refused again. Credits were refunded.',
  generation_timeout: 'The clip never finished rendering. Credits were refunded — a shorter clip or 720p usually gets through.',
  storage_failed: 'The clip rendered but we could not store it. Credits were refunded — try again.',
  submit_unconfirmed: 'We never got confirmation the clip was accepted. Credits are refunded automatically — try again.',
  duplicate_request: 'That request was already running, so it was not charged twice.',
  generation_rejected: 'The request was rejected before rendering started. Credits were refunded.',
  poll_timeout: 'Still rendering — it will appear in your library once it lands, and nothing extra is charged.',
};
const videoFailCopy = (code: string) => VIDEO_FAIL_COPY[code] ?? 'The clip failed to render. Credits were refunded.';

type Account = { platform: Platform; handle: string | null; displayName: string | null; avatarUrl: string | null; isStub: boolean; lastRefreshError: string | null };
// perPlatform/approved ride along from a loaded autopilot draft: dropping them
// on save loses its per-platform copy and a mid-render approval.
type Variant = { label: string; text: string; score?: number; rationale?: string; perPlatform?: Partial<Record<Platform, string>>; approved?: boolean };
type PublishRow = { platform: Platform; ok: boolean; url?: string | null; error?: string };
type Result =
  | { kind: 'scheduled'; platforms: string[]; at: Date; skipped: string[] }
  | { kind: 'published'; rows: PublishRow[] };

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nextHour = () => { const d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return d; };
const future = (iso?: string | null) => { const d = iso ? new Date(iso) : null; return d && d.getTime() > Date.now() + 60_000 ? d : null; };
const label = (p: string) => PLATFORM_LABELS[p] ?? p;

/** apiPost throws "<status>: <body>". Pull the JSON body back out. */
function errBody(e: unknown): { status: number; body: Record<string, unknown> } | null {
  const m = (e instanceof Error ? e.message : '').match(/^(\d{3}):\s*([\s\S]*)$/);
  if (!m) return null;
  try { return { status: Number(m[1]), body: JSON.parse(m[2]) }; } catch { return { status: Number(m[1]), body: {} }; }
}

/** A per-platform publish error is "code: sentence" — show the sentence. */
function reasonCopy(err?: string): string {
  const m = err?.match(/^([a-z_]+)(?::\s*([\s\S]+))?$/);
  if (!err) return 'Could not post. Try again.';
  if (m) return m[2] ?? 'Could not post. Try again.';
  return err;
}
const needsReconnect = (err?: string) => /platform_not_connected|reconnect|expired|revoked|token|permission|no_page/i.test(err ?? '');

export default function Compose({ draftId, onDone, initial }: {
  draftId?: string | null;
  onDone?: () => void;
  /** Prefill from the URL (?prompt, ?slot, ?platforms) — calendar's "Edit in compose". */
  initial?: { prompt?: string; slot?: string; platforms?: string };
}) {
  const [body, setBody] = useState(initial?.prompt ?? '');
  const [prompt, setPrompt] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  /** Text the user wrote for one platform. Only these are sent as perPlatformText. */
  const [custom, setCustom] = useState<Partial<Record<Platform, string>>>({});
  /** Per-platform copy the agent wrote, offered as the start of an override. */
  const [machine, setMachine] = useState<Partial<Record<Platform, string>>>({});
  const [picked, setPicked] = useState<Platform[] | null>(() => {
    const ps = initial?.platforms?.split(',').map((s) => SHORT_TO_PLATFORM[s.trim()]).filter(Boolean);
    return ps?.length ? ps : null;
  });
  const [attached, setAttached] = useState<MediaItem[]>([]);
  /** The attached motion graphic open in the editor. */
  const [editing, setEditing] = useState<MediaItem | null>(null);
  /** The last video rendered in this session (chat edits it) and the smart card's Length (chat sets it). */
  const [rendered, setRendered] = useState<MediaItem | null>(null);
  const [videoLength, setVideoLength] = useState<number | null>(null);
  /** The smart card's plan on screen — the preview's placeholder until the video exists. */
  const [planSlot, setPlanSlot] = useState<Omit<VideoSlot, 'rendering'> | null>(null);
  // Local wall-clock times are the browser's: computed on the server (UTC) they'd mismatch hydration,
  // so both are set after mount.
  const [when, setWhen] = useState('');
  const whenSet = useRef(Boolean(future(initial?.slot)));
  // Picker floor, fixed at mount; schedule() still rejects past times at submit.
  const [minWhen, setMinWhen] = useState('');
  useEffect(() => {
    // Mount-only, client-only values: the documented hydration-safe pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinWhen(toLocalInput(new Date(Date.now() + 60_000)));
    setWhen((w) => w || toLocalInput(future(initial?.slot) ?? nextHour()));
    // Compose is keyed by slot: initial never changes for a mounted instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [preset, setPreset] = useState('announcement');
  const [research, setResearch] = useState(false);
  const [media, setMedia] = useState<'text' | 'image' | 'video'>('video');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'write' | 'schedule' | 'post'>(null);
  const lock = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [creditError, setCreditError] = useState<{ balance: number; needed: number } | null>(null);
  const { mutate } = useSWRConfig();
  const refreshCredits = () => { void mutate('/api/credits'); };

  const gen = useMediaGen({
    added: (items) => {
      // A batch of images becomes a carousel; of several clips, the first is attached and the rest wait in the library.
      const take = items[0]?.mimeType?.startsWith('video/') ? items.slice(0, 1) : items;
      setAttached((cur) => [...cur, ...take].slice(0, MAX_ATTACHED));
      if (take[0]?.mimeType?.startsWith('video/')) setRendered(take[0]);
      setCreditError(null);
      refreshCredits();
    },
    notice: setNotice,
    credits: (e) => { setCreditError(e); refreshCredits(); },
    videoSettled: ({ added, total, failed, notes = [] }) => {
      refreshCredits();
      const reasons = [...new Set(failed)].map(videoFailCopy);
      const extra = added > 1 ? 'The other clips are in your library.' : null;
      setNotice([failed.length && added ? `${added} of ${total} clips made.` : null, extra, ...reasons, ...new Set(notes)].filter(Boolean).join(' ') || null);
    },
  });

  const { data: accounts } = useApi<Account[]>('/api/accounts');
  const { data: plan } = useApi<{ nextEmptySlot?: string }>('/api/plan');
  const connected = useMemo(() => [...new Set((accounts ?? []).map((a) => a.platform))], [accounts]);
  const ready = attached.filter((m) => !m.uploading);
  /** What actually gets posted: in Video mode only the clip — the other attachments are its references. */
  const out = postMedia(media, ready);
  const kind = media === 'video' ? 'video' : postKind(out);
  const selected = picked ?? connected;
  const targets = connected.filter((p) => selected.includes(p) && supportsKind(p, kind));
  const textFor = (p: Platform) => custom[p] ?? body;
  const over = targets.filter((p) => textFor(p).length > LIMIT[p]);

  // The next free slot in the plan, unless the URL or the user already chose a time.
  useEffect(() => {
    const d = future(plan?.nextEmptySlot);
    if (d && !whenSet.current) setWhen(toLocalInput(d));
  }, [plan?.nextEmptySlot]);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    (async () => {
      const r = await fetch(`/api/drafts/${draftId}`, { credentials: 'include' }).catch(() => null);
      if (cancelled) return;
      if (!r?.ok) { setNotice('Could not load this draft. Refresh to try again.'); return; }
      const d = (await r.json()) as {
        id: string; prompt: string | null; body: string; preset: string | null; plannedAt?: string | null;
        variants: (Variant & { perPlatform?: Partial<Record<Platform, string>> })[];
        selectedVariantLabel: string | null; targetPlatforms: Platform[];
        perPlatformText: Partial<Record<Platform, string>> | null;
        media: { id: string; url: string; mimeType: string; posterUrl?: string }[] | null;
      };
      if (cancelled) return;
      setSavedId(d.id);
      setBody(d.body ?? '');
      setPrompt(d.prompt ?? '');
      if (d.preset) setPreset(d.preset);
      setVariants(d.variants ?? []);
      setChosen(d.selectedVariantLabel);
      setPicked(d.targetPlatforms?.length ? d.targetPlatforms : null);
      setMedia(postKind(d.media));
      setAttached((d.media ?? []).map((m) => ({ id: m.id, url: m.url, mimeType: m.mimeType, label: m.url.split('/').pop() || 'Media', ...(m.posterUrl && { posterUrl: m.posterUrl }) })));
      // Copy the agent wrote is a suggestion; only text that differs from it
      // (and from the body) is something the user customized.
      const snap = d.variants?.[0]?.perPlatform ?? {};
      const own = d.perPlatformText ?? {};
      setMachine({ ...snap, ...own });
      setCustom(Object.fromEntries(Object.entries(own).filter(([p, t]) => t && t !== d.body && t !== snap[p as Platform])));
      const planned = future(d.plannedAt);
      if (planned) { whenSet.current = true; setWhen(toLocalInput(planned)); }
    })();
    return () => { cancelled = true; };
  }, [draftId]);

  /** Shared guard + error handling for anything that spends or posts. */
  const run = async (what: 'write' | 'schedule' | 'post', fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(what);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const b = errBody(e);
      if (b?.status === 402 && b.body.error === 'insufficient_credits') {
        setCreditError({ balance: Number(b.body.balance ?? 0), needed: Number(b.body.needed ?? 0) });
        refreshCredits();
      } else if (what === 'post' && Array.isArray(b?.body.results)) {
        setResult({ kind: 'published', rows: b.body.results as PublishRow[] });
      } else {
        setNotice(friendlyApiError(e));
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const write = () => run('write', async () => {
    const p = body.trim();
    const r = await apiPost<{ variants?: (Variant & { id?: string })[]; toolsUsed?: string[] }>('/api/compose/variants', {
      prompt: p, preset, platforms: targets.length ? targets : connected, withTools: research,
    });
    const vs = (r.variants ?? []).map((v, i) => ({ ...v, label: v.label ?? v.id ?? String.fromCharCode(65 + i) }));
    refreshCredits();
    setCreditError(null);
    if (!vs.length) { setNotice('No draft came back. Try again.'); return; }
    setPrompt(p);
    setVariants(vs);
    setChosen(vs[0].label);
    setBody(vs[0].text);
    if (research && r.toolsUsed?.length) setNotice(`Researched with ${r.toolsUsed.join(' + ')}.`);
  });

  /** Create or update the draft. Remembers the id so a retry never makes a second draft. */
  const save = async () => {
    const payload = {
      prompt,
      body,
      variants: variants.map(({ label: l, text, score, rationale, perPlatform, approved }) => ({ label: l, text, score, rationale, perPlatform, approved })),
      selectedVariantLabel: chosen,
      targetPlatforms: targets,
      perPlatformText: Object.fromEntries(targets.filter((p) => custom[p] && custom[p] !== body).map((p) => [p, custom[p]!])),
      media: out.filter((m) => m.id && m.url && m.mimeType).map((m) => ({ id: m.id!, url: m.url!, mimeType: m.mimeType! })),
      preset,
    };
    const d = savedId ? await apiPatch<{ id: string }>(`/api/drafts/${savedId}`, payload) : await apiPost<{ id: string }>('/api/drafts', payload);
    setSavedId(d.id);
    return d.id;
  };

  const schedule = () => run('schedule', async () => {
    const at = new Date(when);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) { setNotice('Pick a time in the future.'); return; }
    const id = await save();
    const r = await apiPost<{ scheduled: { platform: string }[]; skipped?: string[] }>('/api/schedule', {
      draftId: id, scheduledAt: at.toISOString(), platforms: targets,
    });
    setResult({ kind: 'scheduled', platforms: r.scheduled.map((s) => s.platform), at, skipped: r.skipped ?? [] });
  });

  const postNow = (platforms: Platform[] = targets) => run('post', async () => {
    const id = await save();
    const r = await apiPost<{ results?: PublishRow[] }>('/api/publish', { draftId: id, platforms });
    setResult({ kind: 'published', rows: r.results ?? [] });
  });

  const empty = !body.trim() && out.length === 0;
  const blocker = attached.some((m) => m.uploading) ? 'Waiting for the upload to finish.'
    : empty ? null
    : media === 'video' && !out.length ? (gen.busy === 'video' ? 'Wait for the video to finish rendering.' : 'Generate the video first — or switch to Image or Text only to post without one.')
    : !connected.length ? null
    : !targets.length ? 'Pick at least one platform that takes this kind of post.'
    : over.length ? `Too long for ${over.map((p) => `${label(p)} (${textFor(p).length}/${LIMIT[p]})`).join(', ')}.`
    : null;
  const canSubmit = !empty && !blocker && targets.length > 0 && busy === null;
  const done = result?.kind === 'scheduled' ? result.platforms.length > 0 : result?.rows.length ? result.rows.every((r) => r.ok) : false;
  const readyImages = ready.filter((m) => m.mimeType?.startsWith('image/'));
  const costs = genCosts(gen.s, readyImages.length);
  const writeCost = priceForCompose({ withTools: research, extraSearches: 0 }).credits;
  const retryable = result?.kind === 'published'
    ? result.rows.filter((r) => !r.ok && !r.error?.startsWith('already_publishing') && !r.error?.startsWith('platform_not_connected')).map((r) => r.platform)
    : [];
  const customizable = targets.filter((p) => custom[p] === undefined);
  const stripNote = ready.length === out.length ? null
    : media === 'video' ? 'References for the video — only the video is posted'
    : media === 'text' ? 'Not posted — Text only posts no media'
    : 'Only the images are posted';
  const videoSlot: VideoSlot | null = media === 'video' && !out.length
    ? { ...((gen.s.videoSmart && planSlot) || { aspect: gen.s.videoAspect }), rendering: gen.busy === 'video' }
    : null;

  return (
    <div className="compose">
      {gen.cropFile && (
        <AvatarCropModal file={gen.cropFile} aspect={gen.s.videoAspect} onApply={gen.applyFace} onCancel={() => gen.setCropFile(null)} />
      )}
      {editing?.id && (
        <MotionEditor
          id={editing.id}
          onClose={() => setEditing(null)}
          onCredits={(e) => { setCreditError(e); refreshCredits(); }}
          onCharged={refreshCredits}
          onUse={(item) => { setAttached((cur) => cur.map((a) => (a.id === editing.id ? item : a))); setRendered((r) => (r?.id === editing.id ? item : r)); setEditing(null); }}
        />
      )}
      {creditError && <InsufficientCreditsBanner balance={creditError.balance} needed={creditError.needed} onDismiss={() => setCreditError(null)} />}

      <FromWebsite
        length={videoLength}
        platforms={connected.filter((p) => selected.includes(p) && supportsKind(p, 'video'))}
        onUse={(text, items) => {
          setBody(text);
          setAttached((cur) => [...cur, ...items].slice(0, MAX_ATTACHED));
        }}
        onCredits={(e) => { setCreditError(e); refreshCredits(); }}
        onCharged={() => { setCreditError(null); refreshCredits(); }}
      />

      <div className="compose-editor">
        <label htmlFor="compose-text" className="sr-only">Post</label>
        <textarea
          id="compose-text"
          className="compose-text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your post — or describe it and let AI draft it"
          rows={7}
        />
        <Attachments attached={attached} onChange={setAttached} onNotice={setNotice} onEdit={setEditing} note={stripNote}>
          <span className="compose-spacer" />
          <label className="compose-duration">
            Video length
            {/* Left end = the AI decides; then 6–20 s (the engines' range). */}
            <input
              type="range" min={5} max={20} step={1} value={videoLength ?? 5}
              aria-valuetext={videoLength ? `${videoLength} seconds` : 'AI decides'}
              onChange={(e) => { const n = Number(e.target.value); setVideoLength(n > 5 ? n : null); }}
            />
            <span className="compose-duration-val">{videoLength ? `${videoLength}s` : 'AI decides'}</span>
          </label>
          <button type="button" className="btn ghost sm" disabled={!body.trim() || busy !== null} onClick={write}>
            <Icon name="sparkle" size={12} /> {busy === 'write' ? 'Writing…' : variants.length ? 'Rewrite' : 'Write it for me'} <span className="compose-cost">{writeCost} cr</span>
          </button>
        </Attachments>
      </div>

      <ComposeChat
        body={body} setBody={setBody} platforms={targets} connected={connected} onPlatforms={setPicked} setLength={setVideoLength}
        video={rendered && attached.some((a) => a.id === rendered.id) ? rendered : null}
        onSwap={(old, item) => { setAttached((cur) => cur.map((a) => (a.id === old.id ? item : a))); setRendered(item); }}
        onCredits={(e) => { setCreditError(e); refreshCredits(); }}
        onCharged={refreshCredits}
      />

      {variants.length > 1 && (
        <div className="compose-chips" role="group" aria-label="AI versions">
          <span className="compose-label">Versions</span>
          {variants.map((v) => (
            <button key={v.label} type="button" className={`prompt-chip${chosen === v.label ? ' active' : ''}`} aria-pressed={chosen === v.label} title={v.text} onClick={() => { setChosen(v.label); setBody(v.text); }}>
              {v.label}
            </button>
          ))}
        </div>
      )}

      <section className="compose-media" aria-label="Media">
        <div className="mode-switch" role="radiogroup" aria-label="Add media">
          {([['video', 'Video', 'play'], ['image', 'Image', 'image'], ['text', 'Text only', 'edit']] as const).map(([id, name, icon]) => (
            <button key={id} type="button" role="radio" aria-checked={media === id} className={`opt${media === id ? ' active' : ''}`} onClick={() => setMedia(id)}>
              <Icon name={icon} size={12} /> {name}
            </button>
          ))}
        </div>
        {media !== 'text' && !body.trim() && !(media === 'video' && !gen.s.videoSmart && gen.s.videoMode === 'avatar') && (
          <p className="compose-note">Describe the {media} in the post box above — that text is the prompt.</p>
        )}
        {media === 'image' && (
          <ImageOptions
            gen={gen}
            cost={costs.image}
            attachedImages={readyImages.length}
            disabled={!body.trim() || gen.busy !== null}
            onGenerate={() => gen.generateImage(body.trim(), readyImages.map((m) => m.url!))}
          />
        )}
        {media === 'video' && gen.s.videoSmart && (
          <SmartVideo
            gen={gen}
            text={body}
            platforms={targets}
            attachments={ready.flatMap((m) => (m.url && m.mimeType ? [{ url: m.url, mimeType: m.mimeType }] : []))}
            length={videoLength}
            setLength={setVideoLength}
            onPlan={setPlanSlot}
          />
        )}
        {media === 'video' && !gen.s.videoSmart && (
          <button type="button" className="btn ghost sm" onClick={() => gen.set({ videoSmart: true })}>
            <Icon name="sparkle" size={12} /> Use smart
          </button>
        )}
        {media === 'video' && !gen.s.videoSmart && (
          <VideoOptions
            gen={gen}
            cost={costs.video}
            disabled={(!body.trim() && gen.s.videoMode !== 'avatar') || gen.busy !== null}
            onGenerate={() => gen.generateVideo(body.trim())}
          />
        )}
      </section>

      {gen.render && <RenderStatus render={gen.render} />}
      {notice && <p role="status" aria-live="polite" className="compose-notice">{notice}</p>}

      <section className="stack" aria-label="Platforms">
        {accounts && !connected.length ? (
          <p className="compose-note">No accounts connected. <Link href="/settings/connections">Connect one</Link> to post.</p>
        ) : (
          <div className="compose-chips" role="group" aria-label="Post to">
            {connected.map((p) => {
              const ok = supportsKind(p, kind);
              const acct = accounts?.find((a) => a.platform === p);
              const on = ok && selected.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={`prompt-chip${on ? ' active' : ''}`}
                  aria-pressed={on}
                  disabled={!ok}
                  onClick={() => setPicked(on ? selected.filter((x) => x !== p) : [...selected, p])}
                >
                  <Pglyph p={PLATFORM_TO_SHORT[p]} /> {label(p)}
                  {(acct?.isStub || acct?.lastRefreshError) && <span className="badge badge--warn">reconnect</span>}
                </button>
              );
            })}
          </div>
        )}
        {connected.filter((p) => !supportsKind(p, kind)).map((p) => (
          <p key={p} className="compose-note">{unsupportedReason(p, kind)}</p>
        ))}

        {targets.filter((p) => custom[p] !== undefined).map((p) => (
          <div key={p} className="compose-field">
            <span className="compose-label">
              {label(p)} version · <span className={textFor(p).length > LIMIT[p] ? 'compose-error' : undefined}>{textFor(p).length}/{LIMIT[p]}</span>
            </span>
            <textarea className="input" rows={3} aria-label={`${label(p)} version`} value={custom[p]} onChange={(e) => setCustom((c) => ({ ...c, [p]: e.target.value }))} />
            <button type="button" className="btn ghost sm compose-self-start" onClick={() => setCustom((c) => { const n = { ...c }; delete n[p]; return n; })}>
              Use the main text
            </button>
          </div>
        ))}
        {body.trim() && customizable.length > 0 && (
          <div className="compose-chips">
            {customizable.map((p) => (
              <button key={p} type="button" className={`btn ghost sm${over.includes(p) ? ' compose-error' : ''}`} onClick={() => setCustom((c) => ({ ...c, [p]: machine[p] ?? body }))}>
                Customize for {label(p)}
              </button>
            ))}
          </div>
        )}
      </section>

      {result && (
        <section className="compose-results" aria-live="polite">
          {result.kind === 'scheduled' ? (
            <p>
              Scheduled for {result.at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} on {result.platforms.map(label).join(', ')}.
              {result.skipped.length > 0 && <span className="compose-note"> Skipped {result.skipped.map(label).join(', ')}.</span>}
            </p>
          ) : (
            <ul className="stack">
              {result.rows.map((r) => (
                <li key={r.platform} className="compose-result">
                  <Pglyph p={PLATFORM_TO_SHORT[r.platform] ?? r.platform} />
                  <span className="compose-result-name">{label(r.platform)}</span>
                  {r.ok ? (
                    <>
                      <span className="badge badge--ok">Posted</span>
                      {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="btn ghost sm">View <Icon name="arrow_up_right" size={11} /></a>}
                    </>
                  ) : (
                    <span className="compose-error">
                      {reasonCopy(r.error)}
                      {needsReconnect(r.error) && <> <Link href="/settings/connections">Reconnect</Link></>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            {retryable.length > 0 && (
              <button type="button" className="btn sm" disabled={busy !== null} onClick={() => postNow(retryable)}>
                Retry {retryable.map(label).join(', ')}
              </button>
            )}
            {done && onDone && <button type="button" className="btn primary sm" onClick={onDone}>Done</button>}
            {result.kind === 'scheduled' && done && <Link href="/dashboard" className="btn ghost sm">Open calendar</Link>}
          </div>
        </section>
      )}

      {!done && (
        <div className="stack">
          <div className="compose-actions">
            <label className="compose-when">
              <span className="sr-only">Post at</span>
              <input
                type="datetime-local"
                className="input"
                value={when}
                min={minWhen}
                onChange={(e) => { whenSet.current = true; setWhen(e.target.value); }}
              />
            </label>
            <button type="button" className="btn primary" disabled={!canSubmit} onClick={schedule}>
              {busy === 'schedule' ? 'Scheduling…' : 'Schedule'}
            </button>
            <button type="button" className="btn" disabled={!canSubmit} onClick={() => postNow()}>
              {busy === 'post' ? 'Posting…' : 'Post now'}
            </button>
          </div>
          {blocker && <p className="compose-note">{blocker}</p>}
        </div>
      )}

      <details className="compose-more">
        <summary>Writing options · {PRESETS.find((p) => p.id === preset)?.label ?? preset}{research ? ' + research' : ''}</summary>
        <WritingOptions preset={preset} setPreset={setPreset} research={research} setResearch={setResearch} />
      </details>

      <details className="compose-more" open>
        <summary>Preview</summary>
        <Preview platforms={targets} textFor={textFor} media={out} videoSlot={videoSlot} authorFor={(p) => accounts?.find((a) => a.platform === p)} />
      </details>
    </div>
  );
}
