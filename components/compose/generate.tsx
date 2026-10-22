'use client';

import React, { useEffect, useState } from 'react';
import { priceForAvatar, priceForImage, priceForMotion, priceForMotionAi, priceForVideo } from '../../lib/credits/pricing';
import { DEFAULT_VIDEO_MODEL, MOTION_AI, MOTION_TEMPLATES, VIDEO_MODELS, motionAiExtraMin, type MotionTemplate, type VideoModelId } from '../../lib/ai/models';
import type { MediaItem } from './attachments';

export type VideoMode = 'text' | 'image-to-video' | 'reference' | 'audio-driven' | 'avatar' | 'motion';
export type Anchor = 'start' | 'end' | 'reference' | 'refVideo' | 'audio' | 'avatarFace';

export const DEFAULT_SETTINGS = {
  /** Video tab: the planner picks format, length and sound. false = "Choose myself". */
  videoSmart: true,
  imageSize: '1024x1024' as '1024x1024' | '1536x1024' | '1024x1536',
  imageQuality: 'medium' as 'low' | 'medium' | 'high',
  imageCount: 1,
  autoEnhance: true,
  /** Use the attached images as references for the next image. */
  attachedAsRefs: false,
  videoMode: 'text' as VideoMode,
  videoModel: DEFAULT_VIDEO_MODEL as VideoModelId,
  videoDuration: 8,
  videoQuality: '720p' as '480p' | '720p' | '1080p',
  videoAspect: '9:16' as '9:16' | '1:1' | '16:9',
  videoCount: 1,
  videoFast: false,
  startFrame: null as string | null,
  endFrame: null as string | null,
  refImages: [] as string[],
  refVideo: null as string | null,
  /** Server-probed length of the reference clip; null = unreadable. */
  refVideoSec: null as number | null,
  audio: null as string | null,
  avatarFace: null as string | null,
  avatarVoiceId: null as string | null,
  avatarScript: '',
  avatarAudioMode: 'voice' as 'voice' | 'audio',
  motionTemplate: 'stat' as MotionTemplate,
  /** Under videoMode 'motion': AI-designed instead of a template. */
  motionAi: true,
  motionAiDuration: MOTION_AI.durationSec.default as number,
  /** AI-designed audio. Voiceover or music add 4 cr/s; sound effects are free. */
  motionAiVoiceover: true,
  motionAiSfx: true,
  motionAiMusic: true,
  motionAiLanguage: 'en' as 'en' | 'hi',
};
export type GenSettings = typeof DEFAULT_SETTINGS;

export type VideoFormat = 'ai_video' | 'motion_graphic' | 'hybrid' | 'none';
/** The plan /api/media/plan-video returns; sent back unchanged to generate-auto. */
export type VideoPlan = {
  format: VideoFormat; recipe?: string | null;
  graphics?: { engine?: 'ai_motion' | 'template' | null; template?: string | null } | null;
  footage?: unknown; durationSec: number; aspect: string;
  audio: { narration?: boolean; music?: boolean; sfx?: boolean };
  onScreenText?: string[]; estimatedCredits: number; confidence?: number; summary?: string; reasons?: string[];
  fallback?: unknown;
};
/** An option chip: send `{ format }` back as overrides (or `{ cheapest: true }` for `cheapest`). */
export type PlanOption = { key: string; format: VideoFormat; estimatedCredits: number; label: string; summary: string };
export type PlanResponse = {
  plan: VideoPlan; estimatedCredits: number; summary: string; reasons?: string[];
  alternatives?: PlanOption[]; balance?: number;
  /** False: the best fit costs more than the balance (Generate is refused server-side). */
  affordable?: boolean;
  /** With affordable:false, the cheapest option we could make. */
  cheapest?: PlanOption;
};
/** AI-designed graphics (alone or over footage) open in the motion editor. */
export const planEditable = (p: VideoPlan) => p.format === 'hybrid' || (p.format === 'motion_graphic' && p.graphics?.engine !== 'template');

const CINEMA = VIDEO_MODELS['sociafy-cinema-1'];
/** The fast tier renders up to this long; past it the toggle is disabled and the clip renders on quality. */
export const FAST_MAX_SEC = VIDEO_MODELS['sociafy-motion-1'].fastMaxSec ?? 0;
/** Fast as it will actually be sent: ticked and within the fast tier's length. */
export const fastOn = (s: GenSettings) => s.videoFast && s.videoDuration <= FAST_MAX_SEC;

/** The `audio` body for an AI-designed motion graphic (also what prices it). */
export function motionAiAudio(s: GenSettings) {
  return {
    narration: s.motionAiVoiceover, sfx: s.motionAiSfx, music: s.motionAiMusic,
    ...(s.motionAiVoiceover ? { language: s.motionAiLanguage } : {}),
  };
}

/** Settings Cinema can't serve, as UI copy. Empty = Cinema can take it. */
export function cinemaBlockers(s: GenSettings): string[] {
  return [
    s.videoQuality === '1080p' ? '1080p' : null,
    fastOn(s) ? 'fast render' : null,
    (CINEMA.genModes as readonly string[]).includes(s.videoMode) ? null : s.videoMode === 'reference' ? 'reference images' : 'this source',
  ].filter((x): x is string => x !== null);
}

/** The picked model. Options Cinema can't do (1080p, fast, reference) keep the render on Motion. */
export function videoModel(s: GenSettings): VideoModelId {
  return s.videoModel === 'sociafy-cinema-1' && !cinemaBlockers(s).length ? 'sociafy-cinema-1' : 'sociafy-motion-1';
}

/** The length as rendered: the shared Length control can ask for more (or less) than the model takes. */
export function videoDuration(s: GenSettings): number {
  const { min, max } = VIDEO_MODELS[videoModel(s)].durationSec;
  return Math.max(min, Math.min(s.videoDuration, max));
}

/** Credits for one click. null = priced server-side from a live quote (Cinema). */
export function genCosts(s: GenSettings, attachedImages: number): { image: number; video: number | null } {
  const refs = s.attachedAsRefs ? attachedImages : 0;
  const image = priceForImage(s.imageSize, s.imageQuality, refs).credits * s.imageCount;
  const avatarQ = s.videoQuality === '1080p' ? '720p' : s.videoQuality;
  if (s.videoMode === 'avatar') return { image, video: priceForAvatar(avatarQ).credits };
  if (s.videoMode === 'motion' && s.motionAi) return { image, video: priceForMotionAi(s.motionAiDuration, motionAiAudio(s)).credits };
  if (s.videoMode === 'motion') return { image, video: priceForMotion(MOTION_TEMPLATES[s.motionTemplate].durationSec).credits };
  if (videoModel(s) === 'sociafy-cinema-1') return { image, video: null };
  const refSec = s.videoMode === 'reference' ? s.refVideoSec : null;
  const per = priceForVideo({ durationSec: videoDuration(s), quality: s.videoQuality, fast: fastOn(s), inputDurationSec: refSec ?? undefined });
  return { image, video: per.credits * (refSec ? 1 : s.videoCount) };
}

type ClipPhase = 'queued' | 'rendering' | 'storing' | 'done' | 'failed';
const PHASE_LABEL: Record<ClipPhase, string> = {
  queued: 'Queued', rendering: 'Rendering', storing: 'Saving to your library', done: 'Done', failed: 'Failed',
};
const ORDER: ClipPhase[] = ['queued', 'rendering', 'storing', 'done', 'failed'];
/** `usual` / `slowAfterSec` override the default wait copy (2–4 min, slow after 4). */
export type Render = { startedAt: number; phases: ClipPhase[]; usual?: string; slowAfterSec?: number };

export type GenReport = {
  added: (items: MediaItem[]) => void;
  notice: (msg: string | null) => void;
  credits: (e: { balance: number; needed: number }) => void;
  /** Video jobs settled. `failed` holds public failure codes, one per clip. */
  videoSettled: (r: { added: number; total: number; failed: string[]; notes?: string[] }) => void;
};

type Asset = { id: string; publicUrl: string; mimeType: string; label?: string; posterUrl?: string };
type JobPoll = { status?: 'pending' | 'completed' | 'failed'; providerStatus?: string; asset?: Asset; error?: string; audioWarning?: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a job URL until it settles or `maxMs` passes. `onSlow` fires when a
 *  single poll hangs — for video that IS the storing phase. */
export async function pollJob(url: string, maxMs: number, step: [number, number, number], onPoll?: (pd: JobPoll) => void, onSlow?: () => void) {
  const started = Date.now();
  let interval = step[0];
  while (Date.now() - started < maxMs) {
    await wait(interval);
    interval = Math.min(interval + step[1], step[2]);
    const slow = onSlow ? setTimeout(onSlow, 3_000) : undefined;
    let pd: JobPoll;
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) continue;
      pd = (await r.json().catch(() => ({}))) as JobPoll;
    } catch { continue; } finally { clearTimeout(slow); }
    onPoll?.(pd);
    if (pd.status === 'completed' && pd.asset) return { asset: pd.asset, audioWarning: pd.audioWarning };
    if (pd.status === 'failed') return { failed: pd.error || 'generation_failed' };
  }
  return { failed: 'poll_timeout' };
}

async function postJson(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { r, data };
}

/** Readable copy for a failed generation request. Never the raw body. */
function failCopy(status: number, data: Record<string, unknown>, what: string): string {
  if (typeof data.hint === 'string') return data.hint;
  if (typeof data.message === 'string') return data.message;
  if (status === 401) return 'Your session expired — sign in again.';
  if (status === 429) return 'Too many requests — wait a minute and try again.';
  if (status === 503) return `${what} isn't available right now. Try again shortly.`;
  return `${what} failed. Try again.`;
}

/** Item note for asked-for audio the render couldn't carry. */
export function audioNote(warning: string | undefined): string | undefined {
  if (warning === 'audio_unavailable') return 'Couldn’t add audio this time — the video is silent.';
  if (warning === 'audio_partial') return 'Some audio couldn’t be added.';
  return undefined;
}

const toItem = (a: Asset, aspect?: string, motionAi?: boolean, note?: string): MediaItem => ({
  id: a.id, url: a.publicUrl, mimeType: a.mimeType, label: a.label || 'Generated', aspect, ...(motionAi ? { motionAi } : {}), ...(note ? { note } : {}), ...(a.posterUrl ? { posterUrl: a.posterUrl } : {}),
});

export function useMediaGen(report: GenReport) {
  const [s, setS] = useState<GenSettings>(DEFAULT_SETTINGS);
  const set = (patch: Partial<GenSettings>) => setS((cur) => ({ ...cur, ...patch }));
  const [busy, setBusy] = useState<null | 'image' | 'video'>(null);
  const [render, setRender] = useState<Render | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [voicePreview, setVoicePreview] = useState<{ busy: boolean; url: string | null }>({ busy: false, url: null });

  /** Returns true when the response was handled as an error. */
  const handled = (r: Response, data: Record<string, unknown>, what: string) => {
    if (r.status === 402 && data.error === 'insufficient_credits') {
      report.credits({ balance: Number(data.balance ?? 0), needed: Number(data.needed ?? 0) });
      report.notice(null);
      return true;
    }
    if (!r.ok && r.status !== 202) { report.notice(failCopy(r.status, data, what)); return true; }
    return false;
  };

  const uploadAnchor = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('label', `anchor-${file.name}`);
    const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
    if (!r.ok) { report.notice('Upload failed. Try again.'); return null; }
    return (await r.json()) as { publicUrl: string; durationS: string | null };
  };

  const setAnchor = async (target: Anchor, file: File) => {
    if (target === 'avatarFace') { setCropFile(file); return; } // crop first
    const row = await uploadAnchor(file);
    if (!row) return;
    const url = row.publicUrl;
    if (target === 'start') set({ startFrame: url });
    else if (target === 'end') set({ endFrame: url });
    else if (target === 'audio') set({ audio: url });
    else if (target === 'refVideo') {
      const secs = row.durationS != null ? Number(row.durationS) : NaN;
      set({ refVideo: url, refVideoSec: Number.isFinite(secs) && secs > 0 ? secs : null });
    } else setS((cur) => ({ ...cur, refImages: [...cur.refImages, url].slice(0, 9) }));
  };

  const applyFace = async (blob: Blob) => {
    const file = blob instanceof File ? blob : new File([blob], 'avatar-face.png', { type: blob.type || 'image/png' });
    const row = await uploadAnchor(file);
    if (row) set({ avatarFace: row.publicUrl });
    setCropFile(null);
  };

  const generateImage = async (prompt: string, refs: string[]) => {
    setBusy('image');
    setRender({ startedAt: Date.now(), phases: ['rendering'], usual: 'Images usually take under a minute.', slowAfterSec: 90 });
    report.notice(null);
    try {
      const { r, data } = await postJson('/api/media/generate-image', {
        prompt, size: s.imageSize, quality: s.imageQuality, count: s.imageCount,
        caption: prompt.slice(0, 600), rawPrompt: !s.autoEnhance,
        referenceImageUrls: s.attachedAsRefs && refs.length ? refs.slice(0, 10) : undefined,
      });
      if (handled(r, data, 'Image generation')) return;
      const items = (data.items as Asset[] | undefined) ?? [];
      report.added(items.map((a) => toItem(a, s.imageSize.replace('x', '/'))));
    } catch {
      report.notice('Image generation failed. Check your connection and try again.');
    } finally {
      setRender(null);
      setBusy(null);
    }
  };

  /** Poll video jobs to the end, showing phases, then report what landed.
   *  `motionAi` jobs (AI-designed / hybrid) are slower and open in the editor. */
  const track = async (jobs: { id: string; aspect?: string }[], aspect: string, motionAi: boolean, durationSec = 0) => {
    // Longer AI-designed jobs get more worker time; the copy and the poll window grow with it.
    const extra = motionAiExtraMin(durationSec);
    setRender({
      startedAt: Date.now(), phases: jobs.map(() => 'queued'),
      ...(motionAi ? { usual: `AI-designed motion graphics take ${6 + Math.round(extra / 2)}–${12 + extra} minutes.`, slowAfterSec: (15 + extra) * 60 } : {}),
    });
    const setPhase = (i: number, p: ClipPhase) => setRender((v) => (v ? { ...v, phases: v.phases.map((x, k) => (k === i ? p : x)) } : v));
    const settled = await Promise.all(jobs.map(async (j, i) => {
      const out = await pollJob(
        // AI-designed jobs queue behind a 2-wide worker, so they get longer.
        `/api/media/video-job/${j.id}`, (motionAi ? 40 + extra : 15) * 60_000, [4_000, 500, 8_000],
        (pd) => {
          if (pd.status === 'pending') setPhase(i, pd.providerStatus === 'processing' || pd.providerStatus === 'staged' || pd.providerStatus === 'footage' ? 'rendering' : pd.providerStatus === 'finalizing' ? 'storing' : 'queued');
        },
        () => setPhase(i, 'storing'),
      );
      setPhase(i, 'asset' in out ? 'done' : 'failed');
      return out;
    }));
    const added = settled.flatMap((o, k) => ('asset' in o && o.asset ? [toItem(o.asset, jobs[k]?.aspect?.replace(':', '/') ?? aspect, motionAi, audioNote(o.audioWarning))] : []));
    if (added.length) report.added(added);
    report.videoSettled({ added: added.length, total: jobs.length, failed: settled.flatMap((o) => ('failed' in o && o.failed ? [o.failed] : [])), notes: added.flatMap((m) => (m.note ? [m.note] : [])) });
  };

  const generateVideo = async (prompt: string) => {
    const model = videoModel(s);
    const motion = s.videoMode === 'motion';
    const motionAi = motion && s.motionAi;
    // Template motion graphics render 9:16 or 16:9 only; square falls back to vertical.
    const motionAspect = motionAi ? s.videoAspect : s.videoAspect === '16:9' ? '16:9' : '9:16';
    setBusy('video');
    report.notice(null);
    try {
      const { r, data } = motionAi
        ? await postJson('/api/media/generate-motion', { topic: prompt, template: 'ai', aspect: motionAspect, durationSec: s.motionAiDuration, audio: motionAiAudio(s) })
        : motion
        ? await postJson('/api/media/generate-motion', { topic: prompt, template: s.motionTemplate, aspect: motionAspect })
        : await postJson('/api/media/generate-video', {
        prompt, model, durationSec: videoDuration(s), quality: s.videoQuality, aspect: s.videoAspect,
        count: s.videoCount, caption: prompt.slice(0, 600), rawPrompt: !s.autoEnhance, fast: fastOn(s),
        genMode: s.videoMode,
        startFrameUrl: s.startFrame ?? undefined,
        endFrameUrl: s.endFrame ?? undefined,
        referenceImageUrls: s.videoMode === 'reference' && s.refImages.length ? s.refImages : undefined,
        referenceVideoUrl: s.videoMode === 'reference' ? s.refVideo ?? undefined : undefined,
        audioUrl: s.videoMode === 'audio-driven' ? s.audio ?? undefined : undefined,
      });
      if (handled(r, data, 'Video generation')) return;
      const jobs = (data.jobs as { id: string }[] | undefined) ?? [];
      if (!jobs.length) { report.notice('Video generation did not start. Try again.'); return; }

      await track(jobs, (motion ? motionAspect : s.videoAspect).replace(':', '/'), motionAi, motionAi ? s.motionAiDuration : 0);
    } catch {
      report.notice('Video generation failed. Check your connection and try again.');
    } finally {
      setRender(null);
      setBusy(null);
    }
  };

  /** Smart flow: render the plan the video brain returned. Returns the fresh
   *  plan when the price rose since it was shown (nothing was charged). */
  const generateAuto = async (body: { text: string; plan: VideoPlan; platforms?: string[]; attachments?: { url: string; mimeType: string }[] }): Promise<PlanResponse | null> => {
    setBusy('video');
    report.notice(null);
    try {
      const { r, data } = await postJson('/api/media/generate-auto', body);
      if (r.status === 409 && data.error === 'plan_changed') return data as unknown as PlanResponse;
      if (handled(r, data, 'Video generation')) return null;
      const jobs = (data.jobs as { id: string; aspect?: string }[] | undefined) ?? [];
      if (!jobs.length) { report.notice('Video generation did not start. Try again.'); return null; }
      await track(jobs, body.plan.aspect.replace(':', '/'), planEditable(body.plan), body.plan.durationSec);
    } catch {
      report.notice('Video generation failed. Check your connection and try again.');
    } finally {
      setRender(null);
      setBusy(null);
    }
    return null;
  };

  const generateAvatar = async (prompt: string) => {
    const voice = s.avatarAudioMode === 'voice';
    if (!s.avatarFace) { report.notice('Add a face photo for the avatar.'); return; }
    if (voice && !(s.avatarVoiceId && s.avatarScript.trim())) { report.notice('Pick a voice and write what the avatar should say.'); return; }
    if (!voice && !s.audio) { report.notice('Upload an audio track for the avatar.'); return; }
    setBusy('video');
    setRender({ startedAt: Date.now(), phases: ['queued'], usual: 'Avatars usually take a couple of minutes.', slowAfterSec: 300 });
    report.notice(null);
    try {
      const { r, data } = await postJson('/api/media/generate-avatar', {
        imageUrl: s.avatarFace, aspect: s.videoAspect,
        quality: s.videoQuality === '1080p' ? '720p' : s.videoQuality,
        prompt: prompt || undefined,
        ...(voice ? { voiceId: s.avatarVoiceId, script: s.avatarScript.trim() } : { audioUrl: s.audio }),
      });
      if (handled(r, data, 'Avatar generation')) return;
      const jobId = (data.job as { id: string } | undefined)?.id;
      if (!jobId) { report.notice('Avatar generation did not start. Try again.'); return; }
      setRender((v) => (v ? { ...v, phases: ['rendering'] } : v));
      const out = await pollJob(`/api/media/gen-job/${jobId}`, 8 * 60_000, [5_000, 1_000, 12_000]);
      if ('asset' in out && out.asset) {
        report.added([toItem(out.asset, s.videoAspect.replace(':', '/'))]);
        report.notice(null);
      } else {
        report.notice(out.failed === 'poll_timeout'
          ? 'Still rendering after 8 minutes — it will appear in your library when it lands.'
          : 'The avatar could not be rendered. Credits were refunded — a clear, front-facing photo or a shorter script usually fixes it.');
      }
    } catch {
      report.notice('Avatar generation failed. Check your connection and try again.');
    } finally {
      setRender(null);
      setBusy(null);
    }
  };

  /** Hear the voice say the script before paying for a video. */
  const previewVoice = async () => {
    if (!(s.avatarVoiceId && s.avatarScript.trim())) return;
    setVoicePreview({ busy: true, url: null });
    try {
      const { r, data } = await postJson('/api/tts', { voiceId: s.avatarVoiceId, text: s.avatarScript.trim().slice(0, 600) });
      if (handled(r, data, 'Voice preview')) return;
      const jobId = (data.job as { id: string } | undefined)?.id;
      if (!jobId) return;
      const out = await pollJob(`/api/media/gen-job/${jobId}`, 90_000, [2_000, 500, 5_000]);
      if ('asset' in out && out.asset) setVoicePreview({ busy: false, url: out.asset.publicUrl });
      else report.notice(out.failed === 'poll_timeout' ? 'Still synthesizing — try again in a moment.' : 'The voice could not render that. Credits were refunded — try a shorter script.');
    } catch {
      report.notice('Voice preview failed. Try again.');
    } finally {
      setVoicePreview((v) => ({ ...v, busy: false }));
    }
  };

  return {
    s, set, busy, render, cropFile, setCropFile, setAnchor, applyFace, voicePreview, previewVoice,
    generateImage, generateAuto,
    generateVideo: (prompt: string) => (s.videoMode === 'avatar' ? generateAvatar(prompt) : generateVideo(prompt)),
  };
}
export type MediaGen = ReturnType<typeof useMediaGen>;

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

function useElapsed(startedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

/** The earliest phase any clip is still in ('done' when none is). */
function headOf(render: Render): ClipPhase {
  const active = render.phases.filter((p) => p !== 'done' && p !== 'failed');
  return active.length ? active.reduce((a, b) => (ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a)) : 'done';
}
function summaryOf(render: Render) {
  const done = render.phases.filter((p) => p === 'done').length;
  const head = PHASE_LABEL[headOf(render)];
  return render.phases.length > 1 ? `${head} — ${done} of ${render.phases.length} done` : head;
}
const waitCopy = (render: Render, elapsed: number) => (elapsed >= (render.slowAfterSec ?? 240)
  ? 'Longer than usual — still rendering. It lands in your library even if you leave.'
  : render.usual ?? 'Videos usually take 2–4 minutes.');

/** Live render status. Elapsed time and phase are real; the bar is
 *  deliberately indeterminate because nothing reports a percentage. */
export function RenderStatus({ render }: { render: Render }) {
  const elapsed = useElapsed(render.startedAt);
  const summary = summaryOf(render);
  return (
    <div className="compose-render">
      <div role="status" aria-live="polite" className="sr-only">{summary}</div>
      <div className="row">
        <span className="compose-render-title">{summary}</span>
        <span className="compose-render-time tnum" aria-hidden="true">{mmss(elapsed)}</span>
      </div>
      <div className="render-bar" />
      <p className="compose-note">{waitCopy(render, elapsed)}</p>
    </div>
  );
}

const STEPS: ClipPhase[] = ['queued', 'rendering', 'storing'];

/** The same real phases as a checklist, for the preview's media frame while a job runs. */
export function RenderPhases({ render }: { render: Render }) {
  const elapsed = useElapsed(render.startedAt);
  const head = headOf(render);
  const at = head === 'done' ? STEPS.length : STEPS.indexOf(head);
  const done = render.phases.filter((p) => p === 'done').length;
  return (
    <div className="compose-phases">
      <div role="status" aria-live="polite" className="sr-only">{summaryOf(render)}</div>
      <ul className="compose-phase-list" aria-hidden="true">
        {STEPS.map((p, i) => (
          <li key={p} className={i < at ? 'is-done' : i === at ? 'is-now' : undefined}><i />{PHASE_LABEL[p]}</li>
        ))}
      </ul>
      <span className="compose-phase-time tnum">{mmss(elapsed)}{render.phases.length > 1 ? ` · ${done} of ${render.phases.length} done` : ''}</span>
      <p className="compose-note">{waitCopy(render, elapsed)}</p>
    </div>
  );
}
