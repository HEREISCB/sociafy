'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { useApi, apiPost } from '../lib/ui/fetcher';
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create a Voice Twin"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'flex-end', background: 'rgba(10,10,10,0.45)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(440px, 100%)', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--line)', padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="waveform" size={16} />
            <strong style={{ fontSize: 15 }}>Create a Voice Twin</strong>
          </div>
          <button onClick={onClose} className="btn sm ghost" aria-label="Close"><Icon name="x" size={12} /></button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>
          <span style={{ fontWeight: step === 'audio' ? 700 : 400, color: step === 'audio' ? 'var(--ink)' : 'var(--ink-3)' }}>1 · Your voice</span>
          <span>›</span>
          <span style={{ fontWeight: step === 'consent' ? 700 : 400, color: step === 'consent' ? 'var(--ink)' : 'var(--ink-3)' }}>2 · Consent</span>
        </div>

        {step === 'audio' && (
          <>
            <label style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
              Voice name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My voice"
                maxLength={60}
                style={{ width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elev)', color: 'var(--ink)' }}
              />
            </label>

            <div style={{ fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              Provide <strong>{MIN_S}–{MAX_S}s</strong> of clean, single-speaker speech — no music or background noise. {MIN_S}0–40s works best.
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
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

            {recording && <div style={{ fontSize: 11, color: 'var(--accent)' }}>● Recording… speak naturally, then Stop.</div>}
            {uploading && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Uploading…</div>}

            {localUrl && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, border: '1px solid var(--line-2)', background: 'var(--bg-sunk)' }}>
                <audio src={localUrl} controls style={{ flex: 1, height: 32 }} />
                {durationS != null && (
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: durationOk ? 'var(--ink-3)' : 'var(--danger, #c0392b)' }}>{fmtDur(durationS)}</span>
                )}
              </div>
            )}

            {err && <div style={{ fontSize: 11, color: 'var(--danger, #c0392b)' }}>{err}</div>}

            <button className="btn" disabled={!canContinue} onClick={() => setStep('consent')} style={{ marginTop: 'auto' }}>
              Continue
            </button>
          </>
        )}

        {step === 'consent' && (
          <>
            <div
              style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, lineHeight: 1.6, color: 'var(--ink-2)', padding: 14, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--bg-elev)', maxHeight: 280, overflowY: 'auto' }}
            >
              {VOICE_CONSENT_TEXT}
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: 'var(--ink)', cursor: 'pointer' }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
              <span>This is my own voice. I have the right to clone it and take full responsibility for everything I create with it.</span>
            </label>

            <label style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
              Type your legal name to sign
              <input
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder="Full legal name"
                maxLength={120}
                style={{ width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elev)', color: 'var(--ink)' }}
              />
            </label>

            {err && <div style={{ fontSize: 11, color: 'var(--danger, #c0392b)' }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <button className="btn sm ghost" onClick={() => setStep('audio')}>Back</button>
              <button className="btn" disabled={!canCreate || busy} onClick={submit} style={{ flex: 1 }}>
                {busy ? 'Creating…' : 'Create Voice Twin'}
              </button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>Consent {VOICE_CONSENT_VERSION} · recorded with your account + a timestamp.</div>
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
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') { setDrawerOpen(true); return; }
          onChange(e.target.value);
        }}
        style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-elev)', color: 'var(--ink)', fontSize: 12 }}
      >
        <option value="" disabled>Choose a voice…</option>
        {ready.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
        <option value="__new">+ Create voice…</option>
      </select>
      {voices.some((v) => v.status === 'preparing') && (
        <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Preparing a voice…</span>
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

  const del = async (id: string) => {
    await fetch(`/api/voices/${id}`, { method: 'DELETE', credentials: 'include' });
    mutate();
  };

  const preview = async (voiceId: string) => {
    setPreviewBusy(true); setPreviewUrl(null);
    try {
      const res = await apiPost<{ job: { id: string } }>('/api/tts', { voiceId, text: previewText.slice(0, 300) });
      const url = await pollTts(res.job.id);
      setPreviewUrl(url);
    } catch { setPreviewUrl(null); } finally { setPreviewBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 13 }}>My Voices</strong>
        <button className="btn sm" onClick={() => setDrawerOpen(true)}><Icon name="plus" size={11} /> Create voice</button>
      </div>

      {voices.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>No voices yet. Create your Voice Twin to make avatars speak in your voice.</div>
      )}

      {voices.map((v) => (
        <div key={v.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--bg-elev)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="waveform" size={14} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{v.name}</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: v.status === 'ready' ? 'var(--ink-3)' : v.status === 'failed' ? 'var(--danger, #c0392b)' : 'var(--accent)' }}>
                {v.status}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {v.status === 'ready' && (
                <button className="btn sm ghost" onClick={() => setPreviewFor(previewFor === v.id ? null : v.id)} aria-label="Preview">
                  <Icon name="play" size={11} />
                </button>
              )}
              <button className="btn sm ghost" onClick={() => del(v.id)} aria-label="Delete"><Icon name="trash" size={11} /></button>
            </div>
          </div>

          {previewFor === v.id && v.status === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                rows={2}
                maxLength={300}
                style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--bg-sunk)', color: 'var(--ink)', fontSize: 12, resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn sm" disabled={previewBusy} onClick={() => preview(v.id)}>{previewBusy ? 'Synthesizing…' : 'Preview speech'}</button>
                {previewUrl && <audio src={previewUrl} controls style={{ flex: 1, height: 30 }} />}
              </div>
            </div>
          )}
        </div>
      ))}

      <VoiceCreatorDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={() => mutate()} />
    </div>
  );
}
