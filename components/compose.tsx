'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSWRConfig } from 'swr';
import { AnimatePresence, LazyMotion, MotionConfig } from 'motion/react';
import * as m from 'motion/react-m';
import { Icon, Pglyph } from './icons';
import { apiPatch, apiPost, friendlyApiError, useApi } from '../lib/ui/fetcher';
import { PLATFORM_LABELS, PLATFORM_TO_SHORT, SHORT_TO_PLATFORM } from '../lib/ui/platforms';
import { postKind, supportsKind, unsupportedReason } from '../lib/platforms/capabilities';
import { priceForCompose } from '../lib/credits/pricing';
import { postMedia } from '../lib/ui/postMedia';
import { MOTION_AI } from '../lib/ai/models';
import type { Platform } from '../lib/db/schema';
import { InsufficientCreditsBanner } from './credits';
import { Attachments, MAX_ATTACHED, type MediaItem } from './compose/attachments';
import { DEFAULT_SETTINGS, genCosts, useMediaGen } from './compose/generate';
import { ImageOptions, LengthControl, PRESETS, VideoOptions } from './compose/options';
import { FootageOptions } from './compose/footage';
import { Preview, type VideoSlot } from './compose/preview';
import { AvatarCropModal } from './compose/avatar-crop';
import { MotionEditor } from './compose/motion-editor';
import { SmartVideo } from './compose/smart';
import { FromWebsite } from './compose/from-website';
import { ComposeChat } from './compose/chat';
import { Seg } from './ui';

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
  prompt_rejected: 'The prompt was rejected by the content filter. Reword it before retrying, because the same prompt will be refused again. Credits were refunded.',
  generation_timeout: 'The clip never finished rendering. Credits were refunded. A shorter clip or 720p usually gets through.',
  storage_failed: 'The clip rendered but we could not store it. Credits were refunded, so try again.',
  submit_unconfirmed: 'We never got confirmation the clip was accepted. Credits are refunded automatically, so try again.',
  duplicate_request: 'That request was already running, so it was not charged twice.',
  generation_rejected: 'The request was rejected before rendering started. Credits were refunded.',
  footage_unreadable: 'We couldn’t read or transcribe the footage. Credits were refunded. Re-export your clip as MP4 and try again.',
  poll_timeout: 'Still rendering. It will appear in your library once it lands, and nothing extra is charged.',
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
  const hit = (e instanceof Error ? e.message : '').match(/^(\d{3}):\s*([\s\S]*)$/);
  if (!hit) return null;
  try { return { status: Number(hit[1]), body: JSON.parse(hit[2]) }; } catch { return { status: Number(hit[1]), body: {} }; }
}

/** A per-platform publish error is "code: sentence" — show the sentence. */
function reasonCopy(err?: string): string {
  const hit = err?.match(/^([a-z_]+)(?::\s*([\s\S]+))?$/);
  if (!err) return 'Could not post. Try again.';
  if (hit) return hit[2] ?? 'Could not post. Try again.';
  return err;
}
const needsReconnect = (err?: string) => /platform_not_connected|reconnect|expired|revoked|token|permission|no_page/i.test(err ?? '');

type Format = 'text' | 'image' | 'video';
type Toast = { id: number; msg: string; undo?: () => void };

const loadMotion = () => import('./compose/motion-features').then((r) => r.default);
/** --ease-transition / --ease-reveal (tokens.css), for motion's JS animations. */
const EASE_T = [0.65, 0, 0.35, 1] as const;
const EASE_R = [0.16, 1, 0.3, 1] as const;

const FORMAT_HINT: Record<Format, string> = {
  text: 'Text posts go out as written',
  image: 'Generate an image from the brief, or add your own',
  video: 'Generate a video from the brief',
};

export default function Compose({ draftId, initial, title, onNew }: {
  draftId?: string | null;
  /** Prefill from the URL (?prompt → the Brief, ?slot, ?platforms) — calendar's "Edit in compose". */
  initial?: { prompt?: string; slot?: string; platforms?: string };
  title: string;
  /** Start over with an empty post. */
  onNew: () => void;
}) {
  /** The Brief: the prompt for Write caption, image, video and chat. Saved as the draft's `prompt`, never posted. */
  const [brief, setBrief] = useState(initial?.prompt ?? '');
  /** The Caption: what gets posted. Saved as the draft's `body`. */
  const [caption, setCaption] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  /** Bumped per Write caption so the Versions chips stagger in again. */
  const [round, setRound] = useState(0);
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
  /** The last video rendered in this session (chat edits it). */
  const [rendered, setRendered] = useState<MediaItem | null>(null);
  /** The one video Length (null = the AI decides). Smart plan, Custom, chat and From a website all read it. */
  const [videoLength, setVideoLength] = useState<number | null>(null);
  /** The smart card's plan on screen — the preview's placeholder until the video exists. */
  const [planSlot, setPlanSlot] = useState<VideoSlot | null>(null);
  /** The last generated item: it develops in the preview. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [tab, setTab] = useState<'one' | 'web'>('one');
  /** Phone/narrow only: which column is on screen. */
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const [chatOpen, setChatOpen] = useState(false);
  const closeChat = useCallback(() => setChatOpen(false), []);
  const [previewPick, setPreviewPick] = useState<Platform | null>(null);
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
  const [media, setMedia] = useState<Format>('text');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'write' | 'save' | 'schedule' | 'post'>(null);
  const lock = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [creditError, setCreditError] = useState<{ balance: number; needed: number } | null>(null);
  const { mutate } = useSWRConfig();
  const refreshCredits = () => { void mutate('/api/credits'); };

  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(t);
  }, [toast]);
  const toastSeq = useRef(0);
  /** The chat drawer stops above the pinned bar, so Schedule is never covered. */
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--compose-bar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--compose-bar-h'); };
  }, []);
  const say =(msg: string, undo?: () => void) => setToast({ id: ++toastSeq.current, msg, undo });
  /** Latest Caption/Brief for async callers (Write caption, chat), so Undo restores what was really there. */
  const latest = useRef({ caption, brief });
  useEffect(() => { latest.current = { caption, brief }; });
  /** Overwrite the Caption or Brief; anything that was there gets an Undo. */
  const replaceText = (field: 'Caption' | 'Brief', next: string, fresh?: string) => {
    const set = field === 'Caption' ? setCaption : setBrief;
    const prev = field === 'Caption' ? latest.current.caption : latest.current.brief;
    if (prev === next) return;
    set(next);
    if (prev.trim()) say(`${field} replaced`, () => set(prev));
    else if (fresh) say(fresh);
  };

  const gen = useMediaGen({
    added: (items) => {
      // A batch of images becomes a carousel; of several clips, the first is attached and the rest wait in the library.
      const take = items[0]?.mimeType?.startsWith('video/') ? items.slice(0, 1) : items;
      setAttached((cur) => [...cur, ...take].slice(0, MAX_ATTACHED));
      if (take[0]?.mimeType?.startsWith('video/')) setRendered(take[0]);
      setFresh(take[0]?.id ?? null);
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
  /** The Length control, the chat and From a website share one length; Custom's engines read it too. */
  const setLength = (n: number | null) => {
    setVideoLength(n);
    gen.set({ motionAiDuration: n ?? MOTION_AI.durationSec.default, videoDuration: n ?? DEFAULT_SETTINGS.videoDuration, footageLength: n });
  };

  const { data: accounts } = useApi<Account[]>('/api/accounts');
  const { data: plan } = useApi<{ nextEmptySlot?: string }>('/api/plan');
  const connected = useMemo(() => [...new Set((accounts ?? []).map((a) => a.platform))], [accounts]);
  const ready = attached.filter((x) => !x.uploading);
  /** What actually gets posted: in Video mode only the clip — the other attachments are its references. */
  const out = postMedia(media, ready);
  const kind = media === 'video' ? 'video' : postKind(out);
  const selected = picked ?? connected;
  const targets = connected.filter((p) => selected.includes(p) && supportsKind(p, kind));
  const textFor = (p: Platform) => custom[p] ?? caption;
  const over = targets.filter((p) => textFor(p).length > LIMIT[p]);
  const active = previewPick && targets.includes(previewPick) ? previewPick : targets[0];

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
      // Older drafts kept one text for both: it's the caption; the brief is whatever prompt they had.
      setCaption(d.body ?? '');
      setBrief(d.prompt ?? '');
      if (d.preset) setPreset(d.preset);
      setVariants(d.variants ?? []);
      setChosen(d.selectedVariantLabel);
      setPicked(d.targetPlatforms?.length ? d.targetPlatforms : null);
      setMedia(postKind(d.media));
      setAttached((d.media ?? []).map((x) => ({ id: x.id, url: x.url, mimeType: x.mimeType, label: x.url.split('/').pop() || 'Media', ...(x.posterUrl && { posterUrl: x.posterUrl }) })));
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

  /** Shared guard + error handling for anything that spends, saves or posts. */
  const run = async (what: 'write' | 'save' | 'schedule' | 'post', fn: () => Promise<void>) => {
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
        setPane('preview');
      } else {
        setNotice(friendlyApiError(e));
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const write = () => run('write', async () => {
    const r = await apiPost<{ variants?: (Variant & { id?: string })[]; toolsUsed?: string[] }>('/api/compose/variants', {
      prompt: brief.trim(), preset, platforms: targets.length ? targets : connected, withTools: research,
    });
    const vs = (r.variants ?? []).map((v, i) => ({ ...v, label: v.label ?? v.id ?? String.fromCharCode(65 + i) }));
    refreshCredits();
    setCreditError(null);
    if (!vs.length) { setNotice('No draft came back. Try again.'); return; }
    setVariants(vs);
    setChosen(vs[0].label);
    setRound((n) => n + 1);
    replaceText('Caption', vs[0].text, 'Caption written');
    if (research && r.toolsUsed?.length) setNotice(`Researched with ${r.toolsUsed.join(' + ')}.`);
  });

  /** Create or update the draft. Remembers the id so a retry never makes a second draft. */
  const save = async () => {
    const payload = {
      prompt: brief,
      body: caption,
      variants: variants.map(({ label: l, text, score, rationale, perPlatform, approved }) => ({ label: l, text, score, rationale, perPlatform, approved })),
      selectedVariantLabel: chosen,
      targetPlatforms: targets,
      perPlatformText: Object.fromEntries(targets.filter((p) => custom[p] && custom[p] !== caption).map((p) => [p, custom[p]!])),
      media: out.filter((x) => x.id && x.url && x.mimeType).map((x) => ({ id: x.id!, url: x.url!, mimeType: x.mimeType! })),
      preset,
    };
    const d = savedId ? await apiPatch<{ id: string }>(`/api/drafts/${savedId}`, payload) : await apiPost<{ id: string }>('/api/drafts', payload);
    setSavedId(d.id);
    return d.id;
  };

  const saveDraft = () => run('save', async () => { await save(); say('Draft saved'); });

  const schedule = () => run('schedule', async () => {
    const at = new Date(when);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) { setNotice('Pick a time in the future.'); return; }
    const id = await save();
    const r = await apiPost<{ scheduled: { platform: string }[]; skipped?: string[] }>('/api/schedule', {
      draftId: id, scheduledAt: at.toISOString(), platforms: targets,
    });
    setResult({ kind: 'scheduled', platforms: r.scheduled.map((x) => x.platform), at, skipped: r.skipped ?? [] });
    setPane('preview');
  });

  const postNow = (platforms: Platform[] = targets) => run('post', async () => {
    const id = await save();
    const r = await apiPost<{ results?: PublishRow[] }>('/api/publish', { draftId: id, platforms });
    setResult({ kind: 'published', rows: r.results ?? [] });
    setPane('preview');
  });

  const empty = !caption.trim() && out.length === 0;
  const blocker = attached.some((x) => x.uploading) ? 'Waiting for the upload to finish.'
    : empty ? 'Write a caption first.'
    : media === 'video' && !out.length ? (gen.busy === 'video' ? 'Wait for the video to finish rendering.' : 'Generate the video first, or switch Format to Text.')
    : media === 'image' && gen.busy === 'image' ? 'Wait for the image to finish.'
    : accounts && !connected.length ? 'Connect an account to post.'
    : !targets.length ? 'Pick at least one platform that takes this kind of post.'
    : over.length ? `Too long for ${over.map((p) => `${label(p)} (${textFor(p).length}/${LIMIT[p]})`).join(', ')}.`
    : null;
  const done = result?.kind === 'scheduled' ? result.platforms.length > 0 : result?.rows.length ? result.rows.every((r) => r.ok) : false;
  const canSubmit = !empty && !blocker && targets.length > 0 && busy === null && !done;
  const canSave = Boolean(caption.trim() || brief.trim() || out.length) && busy === null && !done;
  const barMsg = done
    ? `${result?.kind === 'scheduled' ? 'Scheduled' : 'Posted'}. Start a New post to make another.`
    : blocker ?? 'Ready. Schedule for the time set, or post now.';
  const readyImages = ready.filter((x) => x.mimeType?.startsWith('image/'));
  const costs = genCosts(gen.s, readyImages.length);
  const writeCost = priceForCompose({ withTools: research, extraSearches: 0 }).credits;
  const retryable = result?.kind === 'published'
    ? result.rows.filter((r) => !r.ok && !r.error?.startsWith('already_publishing') && !r.error?.startsWith('platform_not_connected')).map((r) => r.platform)
    : [];
  const attachNote = media === 'video' ? 'Photos you add guide the video; only the video is posted.'
    : media === 'text' ? 'Not posted with a Text post. Switch Format to Image to post photos.'
    : ready.length !== out.length ? 'Only the images are posted with the caption.'
    : 'Photos you add are posted with the caption.';
  const videoSlot: VideoSlot | null = media === 'video' && !out.length
    ? (gen.s.videoSmart && planSlot) || { aspect: gen.s.videoAspect }
    : null;
  const tight = targets.length ? targets.reduce((a, p) => (LIMIT[p] < LIMIT[a] ? p : a)) : null;
  const footageMode = media === 'video' && !gen.s.videoSmart && gen.s.videoMode === 'footage';
  const briefNote = !brief.trim() && (media === 'image' || (media === 'video' && !gen.s.videoSmart && gen.s.videoMode !== 'avatar' && !footageMode))
    ? `Write a brief above. It’s what the ${media} is made from.`
    : null;

  /** One chip per connected account that takes this kind of post, here and on the From a website tab. */
  const platformChips = (k: typeof kind) => {
    const cant = connected.filter((p) => !supportsKind(p, k));
    return (
    <>
      {accounts && !connected.length ? (
        <p className="compose-note">No accounts connected. <Link href="/settings/connections">Connect one</Link> to post.</p>
      ) : (
        <div className="compose-chips" role="group" aria-label="Post to">
          {connected.filter((p) => supportsKind(p, k)).map((p) => {
            const acct = accounts?.find((a) => a.platform === p);
            const on = selected.includes(p);
            return (
              <button
                key={p}
                type="button"
                className={`prompt-chip${on ? ' active' : ''}`}
                aria-pressed={on}
                onClick={() => setPicked(on ? selected.filter((x) => x !== p) : [...selected, p])}
              >
                <Pglyph p={PLATFORM_TO_SHORT[p]} /> {label(p)}
                {(acct?.isStub || acct?.lastRefreshError) && <span className="badge badge--warn">reconnect</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* Only where this post can go; one line says where it can't (and why) instead of a dead chip each. */}
      {cant.length > 0 && (
        <p className="compose-note" title={cant.map((p) => unsupportedReason(p, k)).join(' ')}>
          {new Intl.ListFormat('en').format(cant.map(label))} {cant.length > 1 ? 'don’t' : 'doesn’t'} take {k} posts.
        </p>
      )}
    </>
    );
  };

  const resultTitle = !result ? ''
    : result.kind === 'scheduled' ? (done ? 'Scheduled' : 'Nothing was scheduled')
    : done ? 'Posted' : result.rows.some((r) => r.ok) ? 'Posted to some platforms' : 'Couldn’t post';

  return (
    <LazyMotion features={loadMotion} strict>
      <MotionConfig reducedMotion="user">
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
          <ComposeChat
            open={chatOpen} onClose={closeChat}
            body={brief} setBody={(t) => replaceText('Brief', t)} platforms={targets} connected={connected} onPlatforms={setPicked} setLength={setLength}
            video={rendered && attached.some((a) => a.id === rendered.id) ? rendered : null}
            onSwap={(old, item) => { setAttached((cur) => cur.map((a) => (a.id === old.id ? item : a))); setRendered(item); }}
            onCredits={(e) => { setCreditError(e); refreshCredits(); }}
            onCharged={refreshCredits}
          />

          <div className="page-header compose-header">
            <h1>{title}</h1>
            <Seg
              value={tab} onChange={setTab} label="What to make"
              options={[{ id: 'one', label: 'One post' }, { id: 'web', label: <>From a website <small className="seg-aside">many</small></> }]}
            />
          </div>

          {creditError && <InsufficientCreditsBanner balance={creditError.balance} needed={creditError.needed} onDismiss={() => setCreditError(null)} />}

          <div className="compose-tab stack" hidden={tab !== 'web'}>
            <section className="card compose-card" aria-label="Post to">
              <div className="compose-head-row"><span className="compose-title">Post to</span><span className="compose-note">Video posts go to the platforms that take video</span></div>
              {platformChips('video')}
            </section>
            <FromWebsite
              length={videoLength}
              platforms={connected.filter((p) => selected.includes(p) && supportsKind(p, 'video'))}
              onUse={(text, items, combined) => {
                const prev = { ...latest.current };
                setBrief(text);
                if (!combined) setCaption(text);
                setAttached((cur) => [...cur, ...items].slice(0, MAX_ATTACHED));
                // Photos only post from an Image post; a Video post uses them as references.
                if (items.length && media === 'text') setMedia('image');
                setTab('one');
                if (prev.brief.trim() || (!combined && prev.caption.trim())) {
                  say(combined ? 'Brief replaced' : 'Caption and brief replaced', () => { setBrief(prev.brief); setCaption(prev.caption); });
                }
              }}
              onCredits={(e) => { setCreditError(e); refreshCredits(); }}
              onCharged={() => { setCreditError(null); refreshCredits(); }}
            />
          </div>

          <div className="compose-tab compose-one" hidden={tab !== 'one'}>
            <Seg className="compose-panes" value={pane} onChange={setPane} label="View" options={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]} />
            <div className="compose-grid">
              <div className="compose-left" data-off={pane !== 'edit' || undefined}>
                <section className="card compose-card" aria-label="Make it">
                  <div className="compose-field">
                    <div className="compose-head-row"><span className="compose-title">Format</span><span className="compose-note">{FORMAT_HINT[media]}</span></div>
                    <Seg
                      value={media} onChange={setMedia} label="Format"
                      options={[
                        { id: 'text', label: <><Icon name="list" size={12} /> Text</> },
                        { id: 'image', label: <><Icon name="image" size={12} /> Image</> },
                        { id: 'video', label: <><Icon name="play" size={12} /> Video</> },
                      ]}
                    />
                  </div>
                  <div className="compose-field">
                    <div className="compose-head-row">
                      <label htmlFor="compose-brief" className="compose-title">Brief</label>
                      <span className="compose-note">What’s this post about? AI uses this, it isn’t posted</span>
                    </div>
                    <textarea
                      id="compose-brief" className="input compose-textarea" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)}
                      placeholder="e.g. Our cold brew is back for winter: 20% off this week, local delivery only"
                    />
                    <div className="compose-tools">
                      <button type="button" className="btn sm" disabled={!brief.trim() || busy !== null} title={brief.trim() ? undefined : 'Write a brief first'} onClick={write}>
                        <Icon name="sparkle" size={12} /> {busy === 'write' ? 'Writing…' : variants.length ? 'Rewrite caption' : 'Write caption'} <span className="compose-cost">{writeCost} cr</span>
                      </button>
                      <select className="input compose-select" aria-label="Writing style" value={preset} onChange={(e) => setPreset(e.target.value)}>
                        {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      <label className="compose-check" title="Reads the web and your past posts first. Slower, costs more">
                        <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} /> Research the web
                      </label>
                      <span className="compose-spacer" />
                      <button type="button" className="btn ghost sm" aria-expanded={chatOpen} onClick={() => setChatOpen((o) => !o)}>
                        <Icon name="chat" size={12} /> Ask AI
                      </button>
                    </div>
                  </div>

                  <AnimatePresence mode="wait" initial={false}>
                    <m.div
                      key={media} className="compose-panel"
                      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
                      transition={{ duration: 0.28, ease: EASE_T }}
                    >
                      {media === 'text' && (
                        <p className="compose-note">Text posts publish the caption only. To post photos, switch Format to Image.</p>
                      )}
                      {briefNote && <p className="compose-note">{briefNote}</p>}
                      {media === 'image' && (
                        <ImageOptions
                          gen={gen}
                          cost={costs.image}
                          attachedImages={readyImages.length}
                          disabled={!brief.trim() || gen.busy !== null}
                          onGenerate={() => gen.generateImage(brief.trim(), readyImages.map((x) => x.url!))}
                        />
                      )}
                      {media === 'video' && (
                        <>
                          <div className="row compose-wrap">
                            <Seg
                              value={footageMode ? 'edit' : gen.s.videoSmart ? 'auto' : 'custom'} label="Video settings"
                              onChange={(v) => gen.set(v === 'edit'
                                ? { videoSmart: false, videoMode: 'footage' }
                                : { videoSmart: v === 'auto', ...(gen.s.videoMode === 'footage' ? { videoMode: 'text' as const } : {}) })}
                              options={[{ id: 'auto', label: 'Auto' }, { id: 'custom', label: 'Custom' }, { id: 'edit', label: 'Edit my video' }]}
                            />
                            <span className="compose-note">{footageMode ? 'Upload your raw clips; we cut and finish them the way you ask' : gen.s.videoSmart ? 'Auto picks the format from your brief' : 'Pick the kind, engine and sound yourself'}</span>
                          </div>
                          <LengthControl gen={gen} length={videoLength} setLength={setLength} />
                          {footageMode ? (
                            <FootageOptions gen={gen} />
                          ) : gen.s.videoSmart ? (
                            <SmartVideo
                              gen={gen}
                              text={brief}
                              platforms={targets}
                              attachments={ready.flatMap((x) => (x.url && x.mimeType ? [{ url: x.url, mimeType: x.mimeType }] : []))}
                              length={videoLength}
                              onPlan={setPlanSlot}
                            />
                          ) : (
                            <VideoOptions
                              gen={gen}
                              cost={costs.video}
                              disabled={(!brief.trim() && gen.s.videoMode !== 'avatar') || gen.busy !== null}
                              onGenerate={() => gen.generateVideo(brief.trim())}
                            />
                          )}
                        </>
                      )}
                    </m.div>
                  </AnimatePresence>
                </section>

                {notice && <p role="status" aria-live="polite" className="compose-notice">{notice}</p>}

                <m.section layout="position" layoutDependency={media} className="card compose-card" aria-label="Caption">
                  <div className="compose-head-row">
                    <label htmlFor="compose-caption" className="compose-title">Caption</label>
                    <span className={`compose-count tnum${tight && caption.length > LIMIT[tight] ? ' compose-error' : ''}`}>
                      {tight ? `${caption.length} / ${LIMIT[tight]} · ${label(tight)}` : `${caption.length} characters`}
                    </span>
                  </div>
                  <textarea
                    id="compose-caption" className="input compose-textarea" rows={6} value={caption} onChange={(e) => setCaption(e.target.value)}
                    placeholder="Write the caption, or use Write caption above"
                  />
                  <div className="compose-chips" role="group" aria-label="AI versions">
                    <span className="compose-label">Versions</span>
                    {variants.length ? variants.map((v, i) => (
                      <m.button
                        key={`${round}-${v.label}`} type="button" className={`prompt-chip compose-version${chosen === v.label ? ' active' : ''}`} aria-pressed={chosen === v.label} title={v.text}
                        initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06, duration: 0.6, ease: EASE_R }}
                        onClick={() => { setChosen(v.label); replaceText('Caption', v.text); }}
                      >
                        {v.label}
                      </m.button>
                    )) : ['A', 'B', 'C'].map((l) => (
                      <button key={l} type="button" className="prompt-chip compose-version" disabled aria-describedby="compose-versions-note">{l}</button>
                    ))}
                    {!variants.length && <span id="compose-versions-note" className="compose-note">Appear after Write caption</span>}
                  </div>
                  <Attachments attached={attached} onChange={setAttached} onNotice={setNotice} onEdit={setEditing} note={attachNote} />
                </m.section>
              </div>

              <aside className="card compose-card compose-right" data-off={pane !== 'preview' || undefined} aria-label="The post">
                <div className="compose-field">
                  <div className="compose-head-row"><span className="compose-title">Post to</span><span className="compose-note">Tap to add or remove</span></div>
                  {platformChips(kind)}
                </div>

                {result && (
                  <m.section
                    className={`compose-results${done ? ' is-filed' : ''}`} aria-live="polite"
                    initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_R }}
                  >
                    {done && (
                      <m.span className="compose-filed-tick" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2, duration: 0.52, ease: EASE_R }}>
                        <Icon name="check" size={20} />
                      </m.span>
                    )}
                    <h3 className="compose-filed-title">{resultTitle}</h3>
                    {result.kind === 'scheduled' ? (
                      <p>
                        <span className="compose-filed-slot tnum">
                          {result.at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{result.platforms.length ? ` · ${result.platforms.map(label).join(', ')}` : ''}
                        </span>
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
                    <div className="row compose-wrap compose-filed-actions">
                      {retryable.length > 0 && (
                        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => postNow(retryable)}>
                          Retry {retryable.map(label).join(', ')}
                        </button>
                      )}
                      <Link href="/dashboard" className="btn ghost sm">Open calendar</Link>
                      <button type="button" className="btn primary sm" onClick={onNew}>New post</button>
                    </div>
                  </m.section>
                )}

                {!done && (
                  <>
                    <Preview
                      platforms={targets} active={active} onActive={setPreviewPick} textFor={textFor} media={out} videoSlot={videoSlot}
                      job={gen.render} format={media} freshId={fresh}
                      authorFor={(p) => accounts?.find((a) => a.platform === p)}
                    />
                    {active && custom[active] !== undefined ? (
                      <div className="compose-field">
                        <span className="compose-label">
                          {label(active)} version · <span className={textFor(active).length > LIMIT[active] ? 'compose-error' : undefined}>{textFor(active).length}/{LIMIT[active]}</span>
                        </span>
                        <textarea className="input" rows={3} aria-label={`${label(active)} version`} value={custom[active]} onChange={(e) => setCustom((c) => ({ ...c, [active]: e.target.value }))} />
                        <button type="button" className="btn ghost sm compose-self-start" onClick={() => setCustom((c) => { const n = { ...c }; delete n[active]; return n; })}>
                          Use the main caption
                        </button>
                      </div>
                    ) : (
                      <div className="compose-custom">
                        <span className="compose-note">
                          {!active ? 'Pick a platform to customize its caption.'
                            : !caption.trim() ? 'Write a caption first to customize it per platform.'
                            : targets.some((p) => custom[p] !== undefined) ? `Customized for ${targets.filter((p) => custom[p] !== undefined).map(label).join(', ')}`
                            : 'Same caption on every platform'}
                        </span>
                        <button
                          type="button" className={`btn ghost sm${active && over.includes(active) ? ' compose-error' : ''}`} disabled={!active || !caption.trim()}
                          onClick={() => active && setCustom((c) => ({ ...c, [active]: machine[active] ?? caption }))}
                        >
                          <Icon name="edit" size={12} /> Customize for {active ? label(active) : 'a platform'}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </aside>
            </div>

            <div ref={bar} className="compose-bar">
              <div className="compose-toast-wrap">
                <AnimatePresence>
                  {toast && (
                    <m.div
                      key={toast.id} className="compose-toast" role="status"
                      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10, transition: { duration: 0.2 } }}
                      transition={{ duration: 0.28, ease: EASE_R }}
                    >
                      <span>{toast.msg}</span>
                      {toast.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
              <p className="compose-bar-msg" role="status">
                {barMsg}
                {!done && accounts && !connected.length && <> <Link href="/settings/connections">Connect</Link></>}
              </p>
              <label className="compose-when">
                <span className="sr-only">Post at</span>
                <input
                  type="datetime-local" className="input" value={when} min={minWhen} disabled={done}
                  onChange={(e) => { whenSet.current = true; setWhen(e.target.value); }}
                />
              </label>
              <div className="compose-bar-btns">
                <button type="button" className="btn" disabled={!canSave} onClick={saveDraft}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
                <button type="button" className="btn" disabled={!canSubmit} onClick={() => postNow()}>{busy === 'post' ? 'Posting…' : 'Post now'}</button>
                <button type="button" className="btn primary" disabled={!canSubmit} onClick={schedule}>
                  <Icon name="clock" size={13} /> {busy === 'schedule' ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
