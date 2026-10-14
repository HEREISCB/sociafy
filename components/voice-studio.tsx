'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { useApi, apiPost, friendlyApiError } from '../lib/ui/fetcher';
import { VOICE_CONSENT_TEXT, VOICE_CONSENT_VERSION } from '../lib/legal/voiceConsent';

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

/** SWR hook over the caller's Voice Twins. */
export function useVoices() {
  const { data, mutate, isLoading } = useApi<{ voices: Voice[] }>('/api/voices');
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

function fmtDur(s: number): string {
  return `${Math.round(s)}s`;
}

// ---------------------------------------------------------------------------
// Creator drawer
// ---------------------------------------------------------------------------

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
  const [agreed, setAgreed] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Reset everything when the drawer opens.
  useEffect(() => {
    if (open) {
      setStep('audio'); setName(''); setAudioUrl(null); setLocalUrl(null);
      setDurationS(null); setUploading(false); setRecording(false);
      setAgreed(false); setSignature(''); setBusy(false); setErr(null);
    }
  }, [open]);

  const measureAndUse = async (blob: Blob, fileName: string) => {
    setErr(null);
    const url = URL.createObjectURL(blob);
    setLocalUrl(url);
    // Read duration before uploading so we can reject bad clips early.
    const dur = await new Promise<number>((resolve) => {
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => resolve(a.duration);
      a.onerror = () => resolve(NaN);
      a.src = url;
    });
    setDurationS(Number.isFinite(dur) ? dur : null);
    if (Number.isFinite(dur) && (dur < MIN_S || dur > MAX_S)) {
      setErr(`Clip is ${fmtDur(dur)} — needs ${MIN_S}–${MAX_S}s of clean speech.`);
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
    await measureAndUse(f, f.name);
  };

  const startRec = async () => {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await measureAndUse(blob, 'recording.webm');
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setErr('Microphone unavailable. Upload a file instead.');
    }
  };

  const stopRec = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const durationOk = durationS == null || (durationS >= MIN_S && durationS <= MAX_S);
  const canContinue = Boolean(audioUrl && name.trim() && durationOk && !uploading);
  const canCreate = canContinue && agreed && signature.trim().length > 0;

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
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.includes('402') ? 'Not enough credits to create a voice.' : 'Could not create the voice. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="voice-drawer-scrim" onClick={onClose}>
      <div className="voice-drawer" role="dialog" aria-modal="true" aria-labelledby="voice-drawer-head" onClick={(e) => e.stopPropagation()}>
        <div className="voice-drawer-head">
          <h2 id="voice-drawer-head">Create a Voice Twin</h2>
          <button onClick={onClose} className="btn sm ghost" aria-label="Close"><Icon name="x" size={12} /></button>
        </div>

        <div className="voice-steps">
          <span className={step === 'audio' ? 'on' : undefined}>1 · Your voice</span>
          <span aria-hidden>›</span>
          <span className={step === 'consent' ? 'on' : undefined}>2 · Consent</span>
        </div>

        {step === 'audio' && (
          <>
            <label className="set-field">
              <span className="set-label">Voice name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My voice" maxLength={60} />
            </label>

            <p className="set-hint">
              {MIN_S}–{MAX_S}s of clean, single-speaker speech with no music or background noise. 20–40s works best.
            </p>

            <div className="row">
              <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={uploading || recording}>
                <Icon name="upload" size={12} /> Upload audio
              </button>
              {recording ? (
                <button className="btn sm" onClick={stopRec}><Icon name="pause" size={12} /> Stop</button>
              ) : (
                <button className="btn sm" onClick={startRec} disabled={uploading}><Icon name="mic" size={12} /> Record</button>
              )}
              <input ref={fileRef} type="file" accept="audio/*" hidden onChange={onFile} />
            </div>

            {recording && <p className="set-hint" role="status">Recording. Speak naturally, then press Stop.</p>}
            {uploading && <p className="set-hint" role="status">Uploading…</p>}

            {localUrl && (
              <div className="voice-clip">
                <audio src={localUrl} controls />
                {durationS != null && (
                  <span className={`mono set-hint${durationOk ? '' : ' err'}`}>{fmtDur(durationS)}</span>
                )}
              </div>
            )}

            {err && <p className="set-error">{err}</p>}

            <button className="btn primary push" disabled={!canContinue} onClick={() => setStep('consent')}>
              Continue
            </button>
          </>
        )}

        {step === 'consent' && (
          <>
            <div className="voice-consent">{VOICE_CONSENT_TEXT}</div>

            <label className="set-check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>This is my own voice. I have the right to clone it and take full responsibility for everything I create with it.</span>
            </label>

            <label className="set-field">
              <span className="set-label">Type your legal name to sign</span>
              <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Full legal name" maxLength={120} />
            </label>

            {err && <p className="set-error">{err}</p>}

            <div className="row push">
              <button className="btn ghost" onClick={() => setStep('audio')}>Back</button>
              <button className="btn primary" disabled={!canCreate || busy} onClick={submit}>
                {busy ? 'Creating…' : 'Create Voice Twin'}
              </button>
            </div>
            <p className="set-hint">Consent {VOICE_CONSENT_VERSION} is recorded with your account and a timestamp.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Voice picker (used inside the composer's Avatar mode)
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
        <option value="__new">+ Create voice…</option>
      </select>
      {voices.some((v) => v.status === 'preparing') && (
        <span className="set-hint">Preparing a voice…</span>
      )}
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
// Voices manager (rename/delete + quick TTS preview)
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

export function VoicesManager() {
  const { voices, mutate } = useVoices();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('Hi! This is my Voice Twin speaking.');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Deleting a Voice Twin is irreversible and was a single unguarded click.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  /** Open/close a preview panel, never leaving another voice's audio behind. */
  const togglePreview = (id: string) => {
    setPreviewFor((cur) => (cur === id ? null : id));
    setPreviewUrl(null);
    setPreviewError(null);
  };

  const del = async (id: string) => {
    setDelError(null);
    try {
      const r = await fetch(`/api/voices/${id}`, { method: 'DELETE', credentials: 'include' });
      // A failed DELETE used to look exactly like a successful one.
      if (!r.ok) throw new Error(String(r.status));
      setConfirmDel(null);
      await mutate();
    } catch (e) {
      setDelError(friendlyApiError(e));
    }
  };

  const preview = async (voiceId: string) => {
    setPreviewBusy(true); setPreviewUrl(null); setPreviewError(null);
    try {
      const res = await apiPost<{ job: { id: string } }>('/api/tts', { voiceId, text: previewText.slice(0, 300) });
      const url = await pollTts(res.job.id);
      // pollTts returns null on failure AND on timeout. Either way the button
      // used to just go back to idle with nothing to show and nothing to say.
      if (!url) setPreviewError('The preview didn\'t come back. Try again in a moment.');
      setPreviewUrl(url);
    } catch (e) {
      setPreviewError(friendlyApiError(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>Your voices</h3>
        <button className="btn sm" onClick={() => setDrawerOpen(true)}><Icon name="plus" size={12} /> Create voice</button>
      </div>

      {voices.length === 0 && <div className="plan-empty">No voices yet.</div>}

      <div className="voice-list">
        {voices.map((v) => (
          <div key={v.id} className="voice-row">
            <div className="voice-row-top">
              <div className="voice-row-name">
                <Icon name="waveform" size={14} />
                <span>{v.name}</span>
                {v.status !== 'ready' && (
                  <span className={`badge ${v.status === 'failed' ? 'badge--err' : ''}`}>{v.status}</span>
                )}
              </div>
              <div className="row">
                {v.status === 'ready' && (
                  <button className="btn sm ghost" onClick={() => togglePreview(v.id)} aria-label={`Preview ${v.name}`} aria-expanded={previewFor === v.id}>
                    <Icon name="play" size={12} />
                  </button>
                )}
                {confirmDel === v.id ? (
                  <>
                    <button className="btn sm ghost" onClick={() => { setConfirmDel(null); setDelError(null); }}>Keep</button>
                    <button className="btn sm danger" onClick={() => del(v.id)}>Delete for good</button>
                  </>
                ) : (
                  <button className="btn sm ghost" onClick={() => { setConfirmDel(v.id); setDelError(null); }} aria-label={`Delete ${v.name}`}><Icon name="trash" size={12} /></button>
                )}
              </div>
            </div>
            {confirmDel === v.id && (
              <p className="set-hint">Deletes this voice permanently. Anything already made with it keeps working.</p>
            )}
            {delError && confirmDel === v.id && <p className="set-error">{delError}</p>}

            {previewFor === v.id && v.status === 'ready' && (
              <div className="voice-preview">
                <textarea
                  className="input"
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  rows={2}
                  maxLength={300}
                  aria-label="Preview text"
                />
                <div className="row">
                  <button className="btn sm" disabled={previewBusy} onClick={() => preview(v.id)}>{previewBusy ? 'Synthesizing…' : 'Preview speech'}</button>
                </div>
                {previewUrl && <audio src={previewUrl} controls />}
                {previewError && <p className="set-error">{previewError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <VoiceCreatorDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={() => mutate()} />
    </section>
  );
}
