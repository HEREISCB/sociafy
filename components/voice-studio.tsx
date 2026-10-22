'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Button, Drawer, Empty, PageHeader, useToast } from './ui';
import { useApi, apiPatch, apiPost, friendlyApiError } from '../lib/ui/fetcher';
import { creditsFor } from '../lib/credits/pricing';
import { VOICE_CONSENT_TEXT, VOICE_CONSENT_VERSION } from '../lib/legal/voiceConsent';
import type { BrandKit } from '../lib/brand/kit';
import { keepaliveFetch, useDeferred } from './settings-ui';

export type Voice = {
  id: string;
  name: string;
  status: 'preparing' | 'ready' | 'failed';
  refPublicUrl: string;
  refDurationS: string | null;
  language: string | null;
  createdAt: string;
};

const MIN_S = 8;
const MAX_S = 60;
const CREATE_CR = creditsFor('voice_twin_create');
const TTS_CR = creditsFor('tts_synthesis');

/** SWR hook over the caller's Voice Twins; polls while one is still preparing. */
export function useVoices() {
  const { data, mutate, isLoading } = useApi<{ voices: Voice[] }>('/api/voices', {
    refreshInterval: (d) => ((d as { voices?: Voice[] } | undefined)?.voices?.some((v) => v.status === 'preparing') ? 4000 : 0),
  });
  return { voices: data?.voices ?? [], mutate, isLoading };
}

// Upload an audio blob/file to the shared media endpoint → public URL.
async function uploadAudio(file: Blob, name: string): Promise<string | null> {
  const fd = new FormData();
  fd.append('file', file, name);
  fd.append('label', `voice-ref-${name}`);
  const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) return null;
  const row = await r.json();
  return row.publicUrl as string;
}

// ---------------------------------------------------------------------------
// Creator drawer
// ---------------------------------------------------------------------------

/** 0–60 s track: 20–40 s sweet spot shaded, the 8 s minimum marked. */
function LengthMeter({ seconds, live }: { seconds: number; live: boolean }) {
  return (
    <div className="voice-meter-wrap">
      <div className="voice-meter" role="meter" aria-label="Clip length" aria-valuemin={0} aria-valuemax={MAX_S} aria-valuenow={Math.round(seconds)}>
        <span className="voice-meter-sweet" />
        <span className="voice-meter-min" />
        <span className={`voice-meter-fill${live ? ' is-live' : ''}`} style={{ transform: `scaleX(${Math.min(seconds, MAX_S) / MAX_S})` }} />
      </div>
      <div className="voice-meter-lbl" aria-hidden="true"><span>0 s</span><span>8 s min</span><span>20–40 s best</span><span>60 s</span></div>
    </div>
  );
}

export function VoiceCreatorDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (voice: Voice) => void;
}) {
  const [step, setStep] = useState<'audio' | 'consent'>('audio');
  const [name, setName] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [durationS, setDurationS] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);

  // Reset everything when the drawer opens ("adjust state on prop change").
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setStep('audio'); setName(''); setAudioUrl(null); setLocalUrl(null);
      setDurationS(null); setUploading(false); setRecording(false); setElapsed(0);
      setAgreed(false); setSignature(''); setBusy(false); setErr(null);
    }
  }

  // Live timer while recording; stops itself at the 60 s ceiling.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const s = (Date.now() - startedRef.current) / 1000;
      setElapsed(s);
      if (s >= MAX_S) recorderRef.current?.stop();
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  // Closing mid-recording must release the microphone.
  useEffect(() => {
    if (!open && recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, [open]);

  const measureAndUse = async (blob: Blob, fileName: string, fallbackS?: number) => {
    setErr(null);
    const url = URL.createObjectURL(blob);
    setLocalUrl(url);
    // Read duration before uploading so we can reject bad clips early.
    // MediaRecorder webm often reports Infinity, so recordings fall back to the timer.
    const dur = await new Promise<number>((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => resolve(a.duration);
      a.onerror = () => resolve(NaN);
      a.src = url;
    });
    const s = Number.isFinite(dur) ? dur : fallbackS ?? null;
    setDurationS(s);
    if (s != null && (s < MIN_S || s > MAX_S)) {
      setErr(`That clip is ${Math.round(s)} s. It needs ${MIN_S}–${MAX_S} s of clean speech.`);
      return;
    }
    setUploading(true);
    const uploaded = await uploadAudio(blob, fileName);
    setUploading(false);
    if (!uploaded) { setErr('Upload failed. Try again.'); return; }
    setAudioUrl(uploaded);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setAudioUrl(null);
    await measureAndUse(f, f.name);
  };

  const startRec = async () => {
    setErr(null);
    setAudioUrl(null);
    setLocalUrl(null);
    setDurationS(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const took = (Date.now() - startedRef.current) / 1000;
        setElapsed(took);
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await measureAndUse(blob, 'recording.webm', took);
      };
      recorderRef.current = rec;
      startedRef.current = Date.now();
      setElapsed(0);
      rec.start();
      setRecording(true);
    } catch {
      setErr('Microphone unavailable. Upload a file instead.');
    }
  };

  const durationOk = durationS == null || (durationS >= MIN_S && durationS <= MAX_S);
  const canContinue = Boolean(audioUrl && name.trim() && durationOk && !uploading);
  const canCreate = canContinue && agreed && signature.trim().length > 0;
  const audioNote = !name.trim() ? 'Name it to continue.' : recording ? 'Recording…' : uploading ? 'Uploading…' : !localUrl ? 'Record or upload a clip.' : !durationOk ? `Clip must be ${MIN_S}–${MAX_S} s.` : audioUrl ? 'Ready.' : '';

  const submit = async () => {
    if (!canCreate || !audioUrl) return;
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<{ voice: Voice }>('/api/voices', {
        name: name.trim(),
        refAudioUrl: audioUrl,
        consentSignature: signature.trim(),
      });
      onCreated(res.voice);
      onClose();
    } catch (e) {
      setErr(friendlyApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const footer = step === 'audio' ? (
    <>
      <span className="voice-foot-note" role="status">{audioNote}</span>
      <Button variant="primary" disabled={!canContinue} onClick={() => setStep('consent')}>Continue</Button>
    </>
  ) : (
    <>
      <Button onClick={() => setStep('audio')} disabled={busy}>Back</Button>
      <span className="voice-foot-gap" />
      <Button variant="primary" cost={CREATE_CR} busy={busy} disabled={!canCreate} onClick={submit}>
        {busy ? 'Creating…' : 'Create voice twin'}
      </Button>
    </>
  );

  return (
    <Drawer open={open} onClose={onClose} title="New voice twin" footer={footer}>
      <div className="voice-drawer-body">
        <div className="voice-steps">
          <span className={step === 'audio' ? 'on' : undefined}>1 · Your voice</span>
          <span aria-hidden>›</span>
          <span className={step === 'consent' ? 'on' : undefined}>2 · Consent</span>
        </div>

        {step === 'audio' && (
          <>
            <label className="field">
              <span className="set-label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Arjun · founder" maxLength={60} autoFocus />
            </label>
            <p className="set-hint">Talk naturally for 20–40 s in a quiet room. No music, one speaker.</p>
            <LengthMeter seconds={recording ? elapsed : durationS ?? 0} live={recording} />
            <div className="row voice-rec-row">
              {recording ? (
                <Button variant="danger" onClick={() => recorderRef.current?.stop()}><span className="voice-rec-dot" aria-hidden="true" /> Stop</Button>
              ) : (
                <Button variant="primary" onClick={startRec} disabled={uploading}><Icon name="mic" size={12} /> {localUrl ? 'Record again' : 'Record'}</Button>
              )}
              <span className="set-num" aria-live="polite">{recording || durationS ? `${Math.round(recording ? elapsed : durationS ?? 0)} s` : ''}</span>
              <span className="voice-foot-gap" />
              <Button onClick={() => fileRef.current?.click()} disabled={uploading || recording}>
                <Icon name="upload" size={12} /> Upload audio
              </Button>
              <input ref={fileRef} type="file" accept="audio/*" hidden onChange={onFile} />
            </div>
            {localUrl && !recording && <audio className="voice-clip-audio" src={localUrl} controls />}
            {err && <p className="set-error" role="alert">{err}</p>}
          </>
        )}

        {step === 'consent' && (
          <>
            <div className="voice-consent">{VOICE_CONSENT_TEXT}</div>
            <label className="check voice-check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>This is my own voice. I have the right to clone it and take full responsibility for everything I create with it.</span>
            </label>
            <label className="field">
              <span className="set-label">Type your legal name to sign</span>
              <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Full legal name" maxLength={120} />
            </label>
            <p className="set-hint">Consent {VOICE_CONSENT_VERSION} is recorded with your account and a timestamp.</p>
            {err && <p className="set-error" role="alert">{err}</p>}
          </>
        )}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Voice picker (composer's Avatar mode, Brand kit's narrator)
// ---------------------------------------------------------------------------

export function VoicePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (voiceId: string) => void;
}) {
  const { voices, mutate } = useVoices();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const ready = voices.filter((v) => v.status === 'ready');

  return (
    <div className="voice-picker">
      <select
        className="input"
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') { setDrawerOpen(true); return; }
          onChange(e.target.value);
        }}
        aria-label="Voice"
      >
        <option value="" disabled>Choose a voice…</option>
        {ready.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
        {voices.filter((v) => v.status === 'preparing').map((v) => (
          <option key={v.id} value={v.id} disabled>{v.name} (preparing)</option>
        ))}
        <option value="__new">+ New voice twin…</option>
      </select>
      <button type="button" className="btn sm ghost" onClick={() => setDrawerOpen(true)}>
        <Icon name="plus" size={11} /> New
      </button>
      <VoiceCreatorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={(voice) => { mutate(); onChange(voice.id); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voices manager (Settings › Voice twins)
// ---------------------------------------------------------------------------

async function pollTts(jobId: string): Promise<string | null> {
  const started = Date.now();
  let interval = 2_000;
  while (Date.now() - started < 90_000) {
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 500, 5_000);
    const r = await fetch(`/api/media/gen-job/${jobId}`, { credentials: 'include' });
    if (!r.ok) continue;
    const d = (await r.json()) as { status?: string; asset?: { publicUrl: string } };
    if (d.status === 'completed' && d.asset) return d.asset.publicUrl;
    if (d.status === 'failed') return null;
  }
  return null;
}

/** Previews already paid for this session: replaying the same line is free. */
const ttsCache = new Map<string, string>();

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function VoicesManager() {
  const { voices, mutate, isLoading } = useVoices();
  const { data: brand, mutate: mutateBrand } = useApi<{ kit: BrandKit }>('/api/brand-kit');
  const toast = useToast();
  const defer = useDeferred();
  const narratorId = brand?.kit.narratorVoiceId ?? null;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [gone, setGone] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('Our winter menu is back. Here’s what’s new this week.');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const shown = voices.filter((v) => !gone.includes(v.id));
  const cacheKey = previewFor ? `${previewFor}\n${previewText.trim()}` : '';
  const cached = ttsCache.get(cacheKey);

  /** Open/close a preview panel, never leaving another voice's audio behind. */
  const togglePreview = (id: string) => {
    setPreviewFor((cur) => (cur === id ? null : id));
    setPreviewUrl(null);
    setPreviewError(null);
  };

  const setNarrator = async (id: string | null) => {
    const prev = narratorId;
    try {
      await mutateBrand(await apiPatch('/api/brand-kit', { narratorVoiceId: id }), { revalidate: false });
      return prev;
    } catch (e) {
      toast(friendlyApiError(e), { tone: 'err' });
      return undefined;
    }
  };

  const assignNarrator = async (v: Voice) => {
    const prev = await setNarrator(v.id);
    if (prev !== undefined) toast(`${v.name} now narrates your videos`, { undo: () => void setNarrator(prev) });
  };

  // Deleting is deferred behind Undo; the DELETE only goes out once the toast is gone.
  const del = (v: Voice) => {
    setGone((g) => [...g, v.id]);
    if (previewFor === v.id) setPreviewFor(null);
    defer(
      `${v.name} deleted${narratorId === v.id ? ' · videos use the stock narrator' : ''}`,
      async () => {
        const r = await keepaliveFetch(`/api/voices/${v.id}`, 'DELETE').catch(() => null);
        if (!r?.ok) {
          setGone((g) => g.filter((x) => x !== v.id));
          toast(`Couldn’t delete ${v.name}. It’s still here; try again.`, { tone: 'err' });
          return;
        }
        if (narratorId === v.id) void setNarrator(null);
        await mutate();
      },
      () => setGone((g) => g.filter((x) => x !== v.id)),
    );
  };

  const rename = async (v: Voice, next: string) => {
    setRenaming(null);
    const name = next.trim();
    if (!name || name === v.name) return;
    try {
      await apiPatch(`/api/voices/${v.id}`, { name });
      await mutate();
    } catch (e) {
      toast(friendlyApiError(e), { tone: 'err' });
    }
  };

  const preview = async (voiceId: string) => {
    if (cached) { setPreviewUrl(cached); return; }
    setPreviewBusy(true); setPreviewUrl(null); setPreviewError(null);
    const key = cacheKey;
    try {
      const res = await apiPost<{ job: { id: string } }>('/api/tts', { voiceId, text: previewText.trim().slice(0, 300) });
      const url = await pollTts(res.job.id);
      if (!url) setPreviewError('The preview didn’t come back. Try again in a moment.');
      else ttsCache.set(key, url);
      setPreviewUrl(url);
    } catch (e) {
      setPreviewError(friendlyApiError(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const newButton = (
    <Button variant="primary" cost={CREATE_CR} onClick={() => setDrawerOpen(true)}>
      <Icon name="plus" size={12} /> New voice twin
    </Button>
  );

  return (
    <div className="set-page">
      <PageHeader
        title="Voice twins"
        sub="A clone of your voice for avatar videos and narration. Your brand’s tone of voice lives in Brand kit."
        actions={newButton}
      />
      <section className="card voice-list" aria-label="Your voice twins">
        {isLoading && <p className="set-needs-wait">Loading…</p>}
        {!isLoading && shown.length === 0 && (
          <Empty icon="waveform" title="No voice twins yet" action={newButton}>
            Record 20–40 seconds of you talking. Videos then sound like you.
          </Empty>
        )}
        {shown.map((v) => {
          const ready = v.status === 'ready';
          const secs = v.refDurationS ? Math.round(Number(v.refDurationS)) : null;
          return (
            <div key={v.id} className={`voice-row is-${v.status}`}>
              <span className="voice-wave" aria-hidden="true"><Icon name="waveform" size={16} /></span>
              <div className="voice-row-main">
                <div className="voice-row-name">
                  {renaming === v.id ? (
                    <input
                      className="input voice-rename"
                      defaultValue={v.name}
                      maxLength={60}
                      aria-label={`Rename ${v.name}`}
                      autoFocus
                      onBlur={(e) => rename(v, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <b>{v.name}</b>
                  )}
                  {ready && narratorId === v.id && <span className="badge ok">Narrates your videos</span>}
                  {v.status === 'preparing' && <span className="badge">Preparing, usually under a minute</span>}
                  {v.status === 'failed' && <span className="badge err">Failed</span>}
                </div>
                <span className="voice-row-meta">
                  {v.status === 'failed'
                    ? 'The clip couldn’t be used. Try a cleaner 20–40 s recording.'
                    : <>{secs != null && <span className="set-num">{secs} s clip · </span>}added {fmtDate(v.createdAt)}</>}
                </span>
              </div>
              <div className="voice-row-acts">
                <Button size="sm" disabled={!ready} reason={ready ? undefined : 'Available when ready'} aria-expanded={previewFor === v.id} onClick={() => togglePreview(v.id)}>
                  <Icon name="play" size={12} /> Hear it
                </Button>
                {narratorId !== v.id && (
                  <Button size="sm" disabled={!ready} onClick={() => assignNarrator(v)}>Use for videos</Button>
                )}
                <button type="button" className="btn sm ghost" onClick={() => setRenaming(v.id)}>Rename</button>
                <button type="button" className="icon-btn voice-del" aria-label={`Delete ${v.name}`} onClick={() => del(v)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>

              {previewFor === v.id && ready && (
                <div className="voice-preview">
                  <textarea
                    className="input"
                    value={previewText}
                    onChange={(e) => { setPreviewText(e.target.value); setPreviewUrl(null); }}
                    rows={2}
                    maxLength={300}
                    aria-label="Line to hear"
                  />
                  <div className="row">
                    <Button size="sm" variant="primary" busy={previewBusy} cost={cached ? undefined : TTS_CR} disabled={!previewText.trim()} reason="Type a line first" onClick={() => preview(v.id)}>
                      {previewBusy ? 'Speaking… usually 10–20 s' : cached ? 'Play again · free' : 'Hear this line'}
                    </Button>
                    <span className="set-hint">Each new line costs {TTS_CR} cr. Replaying is free.</span>
                  </div>
                  {previewUrl && <audio key={previewUrl} className="develop" src={previewUrl} controls autoPlay />}
                  {previewError && <p className="set-error" role="alert">{previewError}</p>}
                </div>
              )}
            </div>
          );
        })}
      </section>
      <p className="set-hint voice-foot">Deleting a voice twin doesn’t affect videos already made with it.</p>

      <VoiceCreatorDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={() => { mutate(); toast(`Voice twin created · ${CREATE_CR} cr used`); }} />
    </div>
  );
}
