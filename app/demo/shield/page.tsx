'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Sentiment {
  score: number;
  severity: number;
  label: 'crisis' | 'negative' | 'neutral' | 'positive';
  crisisWords: string[];
  negWords: string[];
  theme: string;
}

interface Mention {
  id: string;
  source: 'reddit' | 'gdelt' | 'hackernews';
  url: string;
  title: string;
  body: string;
  author: string;
  engagement: number;
  timestamp: number;
  sentiment: Sentiment;
}

interface ScanResult {
  mentions: Mention[];
  sources: { reddit: number; gdelt: number; hackernews: number };
  total: number;
  brand: string;
}

interface ScriptOutput {
  script: string;
  title: string;
  keyPoints: string[];
  duration: string;
  usedAI: boolean;
}

type Filter = 'all' | 'crisis' | 'negative' | 'neutral' | 'positive';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  google_news: 'Google News',
  hackernews:  'Hacker News',
  wikipedia:   'Wikipedia',
};

const SOURCE_ICONS: Record<string, string> = {
  google_news: '📰',
  hackernews:  '🟤',
  wikipedia:   '📖',
};

const LABEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  crisis:   { bg: 'rgba(220,38,38,0.15)',   text: '#f87171', border: '#ef4444' },
  negative: { bg: 'rgba(245,158,11,0.15)',  text: '#fbbf24', border: '#f59e0b' },
  neutral:  { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', border: '#6b7280' },
  positive: { bg: 'rgba(34,197,94,0.15)',   text: '#4ade80', border: '#22c55e' },
};

const FILTER_TABS: { key: Filter; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'crisis',   label: '🔴 Crisis' },
  { key: 'negative', label: '🟡 Negative' },
  { key: 'neutral',  label: '⚪ Neutral' },
  { key: 'positive', label: '🟢 Positive' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function brandInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]?.toUpperCase() ?? '').slice(0, 2).join('');
}

// ─── Canvas Avatar Renderer ───────────────────────────────────────────────────

function drawAvatarFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  brand: string,
  isSpeaking: boolean,
  frame: number,
  wordIdx: number,
  words: string[],
) {
  // Background
  ctx.fillStyle = '#0C0C0A';
  ctx.fillRect(0, 0, w, h);

  // Subtle radial gradient
  const grd = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.35, h * 0.45);
  grd.addColorStop(0, 'rgba(220,38,38,0.08)');
  grd.addColorStop(1, 'transparent');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h * 0.38;
  const r = Math.min(w, h) * 0.18;

  // Outer pulsing ring
  if (isSpeaking) {
    const pulse = Math.sin(frame * 0.08) * 0.5 + 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 22 + pulse * 10, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(220,38,38,${0.12 + pulse * 0.12})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r + 10 + pulse * 5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(220,38,38,${0.25 + pulse * 0.2})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(220,38,38,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Avatar circle
  const gradient = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
  gradient.addColorStop(0, '#7f1d1d');
  gradient.addColorStop(1, '#450a0a');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Initials
  const initials = brandInitials(brand) || '?';
  ctx.font = `bold ${r * 0.7}px "Geist", ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#fca5a5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, cx, cy);

  // Brand name
  ctx.font = `500 ${h * 0.036}px "Geist", ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = '#f5f5f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${brand} — Official Response`, cx, cy + r + h * 0.075);

  // Sound wave bars
  const barCount = 20;
  const barMaxH = h * 0.055;
  const barW = 3;
  const barGap = 5;
  const totalBarW = barCount * (barW + barGap) - barGap;
  const barStartX = cx - totalBarW / 2;
  const barY = cy + r + h * 0.12;

  for (let i = 0; i < barCount; i++) {
    const phase = frame * 0.12 + i * 0.45;
    const amp = isSpeaking ? (Math.sin(phase) * 0.5 + 0.5) : 0.08;
    const bh = barMaxH * Math.max(0.08, amp);
    ctx.fillStyle = isSpeaking
      ? `rgba(248,113,113,${0.4 + amp * 0.6})`
      : 'rgba(248,113,113,0.15)';
    ctx.beginPath();
    ctx.roundRect(barStartX + i * (barW + barGap), barY - bh / 2, barW, bh, 2);
    ctx.fill();
  }

  // Script karaoke text
  if (words.length > 0) {
    const scriptY = barY + barMaxH / 2 + h * 0.045;
    const lineH = h * 0.038;
    const fontSize = h * 0.032;
    const maxW = w * 0.82;

    // Build lines from words (wrap at maxW)
    ctx.font = `${fontSize}px "Geist", ui-sans-serif, system-ui, sans-serif`;
    const lines: { text: string; startIdx: number }[] = [];
    let line = '';
    let lineStart = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(test).width > maxW && line) {
        lines.push({ text: line, startIdx: lineStart });
        line = words[i];
        lineStart = i;
      } else {
        line = test;
      }
    }
    if (line) lines.push({ text: line, startIdx: lineStart });

    // Find current line
    let currentLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const nextStart = lines[i + 1]?.startIdx ?? words.length;
      if (wordIdx >= lines[i].startIdx && wordIdx < nextStart) { currentLine = i; break; }
    }

    // Show 3 lines centred on current
    const visStart = Math.max(0, currentLine - 1);
    const visLines = lines.slice(visStart, visStart + 3);

    visLines.forEach((l, li) => {
      const absLine = visStart + li;
      const nextStart = lines[absLine + 1]?.startIdx ?? words.length;
      const lineWords = words.slice(l.startIdx, nextStart);
      const isCurrent = absLine === currentLine;

      // Dim non-current lines
      if (!isCurrent) {
        ctx.font = `${fontSize}px "Geist", ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(163,163,163,0.35)';
        ctx.textAlign = 'center';
        ctx.fillText(l.text, cx, scriptY + li * lineH);
        return;
      }

      // Current line: word-by-word highlight
      let xOffset = 0;
      const lineWidth = ctx.measureText(l.text).width;
      let startX = cx - lineWidth / 2;

      lineWords.forEach((word, wi) => {
        const wordWidth = ctx.measureText(word + ' ').width;
        const isSpoken = l.startIdx + wi < wordIdx;
        const isActive = l.startIdx + wi === wordIdx;

        ctx.font = `${isActive ? 600 : 400} ${fontSize}px "Geist", ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = isActive
          ? '#f87171'
          : isSpoken
          ? 'rgba(245,245,244,0.9)'
          : 'rgba(163,163,163,0.5)';
        ctx.textAlign = 'left';
        ctx.fillText(word, startX + xOffset, scriptY + li * lineH);
        xOffset += wordWidth;
      });
    });
  }

  // Recording dot
  if (isSpeaking) {
    const dotAlpha = Math.sin(frame * 0.15) > 0 ? 1 : 0.3;
    ctx.beginPath();
    ctx.arc(w - 24, 24, 7, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(239,68,68,${dotAlpha})`;
    ctx.fill();
    ctx.font = `500 ${h * 0.022}px "Geist", ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(239,68,68,${dotAlpha})`;
    ctx.textAlign = 'right';
    ctx.fillText('LIVE', w - 36, 29);
  }

  // Watermark
  ctx.font = `${h * 0.018}px "Geist Mono", ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(163,163,163,0.25)';
  ctx.textAlign = 'left';
  ctx.fillText('Reputation Shield · Sociafy', 16, h - 12);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ShieldDemoPage() {
  const [brand, setBrand]           = useState('');
  const [scanning, setScanning]     = useState(false);
  const [result, setResult]         = useState<ScanResult | null>(null);
  const [error, setError]           = useState('');
  const [filter, setFilter]         = useState<Filter>('all');
  const [selected, setSelected]     = useState<Mention | null>(null);
  const [generating, setGenerating] = useState(false);
  const [script, setScript]         = useState<ScriptOutput | null>(null);
  const [speaking, setSpeaking]     = useState(false);
  const [wordIdx, setWordIdx]       = useState(0);
  const [frame, setFrame]           = useState(0);

  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const rafRef     = useRef<number>(0);
  const uttRef     = useRef<SpeechSynthesisUtterance | null>(null);
  const scriptWords = script?.script.split(/\s+/) ?? [];

  // Canvas animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !selected) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let f = frame;
    function tick() {
      if (!ctx || !canvas) return;
      f++;
      setFrame(f);
      drawAvatarFrame(
        ctx,
        canvas.width,
        canvas.height,
        result?.brand ?? brand,
        speaking,
        f,
        wordIdx,
        scriptWords,
      );
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, speaking, wordIdx, script, brand, result?.brand]);

  // Cleanup speech on unmount
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    };
  }, []);

  const doScan = useCallback(async () => {
    if (!brand.trim()) return;
    setScanning(true);
    setError('');
    setResult(null);
    setSelected(null);
    setScript(null);
    setSpeaking(false);
    setWordIdx(0);
    window.speechSynthesis?.cancel();

    try {
      const res = await fetch('/api/demo/shield/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: brand.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Scan failed');
      setResult(data);
      if (data.mentions.length > 0) {
        const first = data.mentions.find((m: Mention) =>
          m.sentiment.label === 'crisis' || m.sentiment.label === 'negative'
        ) ?? data.mentions[0];
        setSelected(first);
      }
    } catch (e: any) {
      setError(e.message ?? 'Unknown error');
    } finally {
      setScanning(false);
    }
  }, [brand]);

  const doGenerateScript = useCallback(async () => {
    if (!selected || !result) return;
    setGenerating(true);
    setScript(null);
    setSpeaking(false);
    setWordIdx(0);
    window.speechSynthesis?.cancel();

    try {
      const res = await fetch('/api/demo/shield/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: result.brand, mention: selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Script gen failed');
      setScript(data);
    } catch (e: any) {
      setError(e.message ?? 'Script generation failed');
    } finally {
      setGenerating(false);
    }
  }, [selected, result]);

  const doSpeak = useCallback(() => {
    if (!script || typeof window === 'undefined' || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    setSpeaking(true);
    setWordIdx(0);

    const utt = new SpeechSynthesisUtterance(script.script);
    utt.rate  = 0.92;
    utt.pitch = 1.0;
    utt.lang  = 'en-US';

    // Pick best available voice
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      v.lang === 'en-US' && (v.name.includes('Google') || v.name.includes('Natural'))
    ) ?? voices.find(v => v.lang === 'en-US') ?? null;
    if (preferred) utt.voice = preferred;

    const words = script.script.split(/\s+/);
    utt.onboundary = (e) => {
      if (e.name !== 'word') return;
      // Count words up to charIndex
      const textBefore = script.script.slice(0, e.charIndex);
      const idx = textBefore.split(/\s+/).filter(Boolean).length;
      setWordIdx(idx);
    };

    utt.onend   = () => { setSpeaking(false); setWordIdx(words.length); };
    utt.onerror = () => { setSpeaking(false); };

    uttRef.current = utt;
    window.speechSynthesis.speak(utt);
  }, [script]);

  const doStop = useCallback(() => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const filtered = result?.mentions.filter(
    m => filter === 'all' || m.sentiment.label === filter
  ) ?? [];

  const counts = result
    ? {
        crisis:   result.mentions.filter(m => m.sentiment.label === 'crisis').length,
        negative: result.mentions.filter(m => m.sentiment.label === 'negative').length,
        neutral:  result.mentions.filter(m => m.sentiment.label === 'neutral').length,
        positive: result.mentions.filter(m => m.sentiment.label === 'positive').length,
      }
    : null;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0C0C0A',
      color: '#f5f5f4',
      fontFamily: '"Geist", ui-sans-serif, -apple-system, system-ui, sans-serif',
      padding: '0',
    }}>
      {/* Header */}
      <div style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '16px 32px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: '#ef4444',
            boxShadow: '0 0 0 4px rgba(239,68,68,0.25)',
            animation: 'pulse 2s infinite',
          }} />
          <span style={{ fontFamily: '"Geist Mono", monospace', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#9ca3af' }}>
            Sociafy
          </span>
        </div>
        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)' }} />
        <span style={{ fontSize: 15, fontWeight: 500, color: '#f5f5f4' }}>Reputation Shield</span>
        <span style={{
          marginLeft: 'auto',
          fontFamily: '"Geist Mono", monospace', fontSize: 10,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          background: 'rgba(239,68,68,0.15)', color: '#f87171',
          border: '1px solid rgba(239,68,68,0.3)',
          padding: '3px 10px', borderRadius: 100,
        }}>Demo Mode · Free APIs Only</span>
      </div>

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 32px 64px' }}>

        {/* Search */}
        <div style={{ marginBottom: 36 }}>
          <h1 style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 42, fontWeight: 340, letterSpacing: '-0.03em',
            margin: '0 0 8px',
            background: 'linear-gradient(135deg, #f5f5f4 0%, #a8a29e 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            What is the internet saying about your brand?
          </h1>
          <p style={{ color: '#78716c', fontSize: 15, margin: '0 0 24px' }}>
            Scans Google News · Hacker News · Wikipedia &mdash; all free, zero API keys needed.
          </p>

          <div style={{ display: 'flex', gap: 12, maxWidth: 680 }}>
            <input
              type="text"
              value={brand}
              onChange={e => setBrand(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doScan()}
              placeholder='Try "OpenAI", "Tesla", "Paytm", "Zomato"...'
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10,
                padding: '14px 18px',
                fontSize: 15,
                color: '#f5f5f4',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={doScan}
              disabled={scanning || !brand.trim()}
              style={{
                padding: '14px 28px',
                background: scanning ? 'rgba(239,68,68,0.4)' : '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 500,
                cursor: scanning ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                transition: 'background 0.2s',
                whiteSpace: 'nowrap',
              }}
            >
              {scanning ? '⏳ Scanning...' : '🔍 Scan Brand'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 10, padding: '12px 18px', color: '#f87171',
            marginBottom: 24, fontSize: 14,
          }}>
            ⚠️ {error}
          </div>
        )}

        {/* Scanning progress */}
        {scanning && (
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12, padding: 24, marginBottom: 24,
          }}>
            <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#78716c', marginBottom: 16 }}>
              Scanning sources for "{brand}"
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                { key: 'google_news', label: 'Google News',  icon: '📰' },
                { key: 'hackernews',  label: 'Hacker News',  icon: '🟤' },
                { key: 'wikipedia',   label: 'Wikipedia',    icon: '📖' },
              ].map(s => (
                <div key={s.key} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8, padding: '10px 16px',
                }}>
                  <span>{s.icon}</span>
                  <span style={{ fontSize: 13, color: '#a8a29e' }}>{s.label}</span>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: '2px solid #78716c',
                    borderTopColor: '#ef4444',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {result && !scanning && (
          <>
            {/* Stats bar */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              <div style={{
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10, padding: '14px 20px', flex: '1 1 140px',
              }}>
                <div style={{ fontSize: 26, fontFamily: '"Fraunces", serif', fontWeight: 400, letterSpacing: '-0.02em' }}>{result.total}</div>
                <div style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#78716c', marginTop: 4 }}>Total Mentions</div>
              </div>
              {(['crisis', 'negative', 'neutral', 'positive'] as const).map(lbl => {
                const c = counts![lbl];
                const col = LABEL_COLORS[lbl];
                return (
                  <div key={lbl} style={{
                    background: col.bg, border: `1px solid ${col.border}40`,
                    borderRadius: 10, padding: '14px 20px', flex: '1 1 120px',
                  }}>
                    <div style={{ fontSize: 26, fontFamily: '"Fraunces", serif', fontWeight: 400, letterSpacing: '-0.02em', color: col.text }}>{c}</div>
                    <div style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: col.text, opacity: 0.7, marginTop: 4 }}>{lbl}</div>
                  </div>
                );
              })}
              <div style={{
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10, padding: '14px 20px', flex: '1 1 200px',
              }}>
                <div style={{ fontSize: 13, color: '#a8a29e', marginBottom: 6 }}>Sources scanned</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {Object.entries(result.sources).map(([k, v]) => (
                    <span key={k} style={{ fontSize: 12, color: '#78716c' }}>
                      {SOURCE_ICONS[k]} <span style={{ color: '#f5f5f4', fontWeight: 500 }}>{v}</span> {SOURCE_LABELS[k]}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Main layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 20, alignItems: 'start' }}>

              {/* Mentions list */}
              <div>
                {/* Filter tabs */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                  {FILTER_TABS.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setFilter(t.key)}
                      style={{
                        padding: '6px 12px', fontSize: 12, borderRadius: 100,
                        border: '1px solid',
                        borderColor: filter === t.key ? '#ef4444' : 'rgba(255,255,255,0.1)',
                        background: filter === t.key ? 'rgba(239,68,68,0.15)' : 'transparent',
                        color: filter === t.key ? '#f87171' : '#9ca3af',
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {t.label} {counts && t.key !== 'all' ? `(${counts[t.key as keyof typeof counts]})` : ''}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '72vh', overflowY: 'auto' }}>
                  {filtered.length === 0 && (
                    <div style={{ color: '#78716c', fontSize: 14, padding: '20px 0' }}>No mentions in this category.</div>
                  )}
                  {filtered.map(m => {
                    const col = LABEL_COLORS[m.sentiment.label];
                    const isSelected = selected?.id === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => { setSelected(m); setScript(null); setSpeaking(false); setWordIdx(0); window.speechSynthesis?.cancel(); }}
                        style={{
                          textAlign: 'left',
                          background: isSelected ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.025)',
                          border: `1px solid ${isSelected ? '#ef444440' : 'rgba(255,255,255,0.07)'}`,
                          borderRadius: 10,
                          padding: '14px 16px',
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                          width: '100%',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                          <span style={{
                            fontSize: 10, fontFamily: '"Geist Mono", monospace', letterSpacing: '0.08em',
                            textTransform: 'uppercase', padding: '2px 8px', borderRadius: 100,
                            background: col.bg, color: col.text, border: `1px solid ${col.border}50`,
                            whiteSpace: 'nowrap',
                          }}>
                            {m.sentiment.label === 'crisis' ? '🔴' : m.sentiment.label === 'negative' ? '🟡' : m.sentiment.label === 'positive' ? '🟢' : '⚪'} {m.sentiment.label}
                          </span>
                          <span style={{ fontSize: 10, color: '#57534e', whiteSpace: 'nowrap' }}>
                            {SOURCE_ICONS[m.source]} {timeAgo(m.timestamp)}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#e7e5e4', lineHeight: 1.45, marginBottom: 4 }}>
                          {m.title.slice(0, 100)}{m.title.length > 100 ? '…' : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: '#78716c' }}>{SOURCE_LABELS[m.source]}</span>
                          {m.sentiment.severity > 0 && (
                            <span style={{ fontSize: 11, color: col.text, opacity: 0.7 }}>
                              Severity {m.sentiment.severity}/10
                            </span>
                          )}
                          {m.engagement > 0 && (
                            <span style={{ fontSize: 11, color: '#78716c' }}>
                              ↑ {m.engagement} pts
                            </span>
                          )}
                        </div>
                        {m.sentiment.crisisWords.length > 0 && (
                          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {m.sentiment.crisisWords.map(w => (
                              <span key={w} style={{
                                fontSize: 10, fontFamily: '"Geist Mono", monospace',
                                background: 'rgba(239,68,68,0.12)', color: '#f87171',
                                padding: '1px 6px', borderRadius: 4,
                              }}>{w}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Detail panel */}
              <div>
                {!selected ? (
                  <div style={{
                    background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: 14, padding: 40, textAlign: 'center', color: '#57534e',
                  }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>👆</div>
                    <div style={{ fontSize: 15 }}>Select a mention to analyze and generate a response video</div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                    {/* Mention detail */}
                    <div style={{
                      background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 14, padding: 24,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
                        <div>
                          <div style={{
                            fontFamily: '"Geist Mono", monospace', fontSize: 10, letterSpacing: '0.1em',
                            textTransform: 'uppercase', color: LABEL_COLORS[selected.sentiment.label].text,
                            marginBottom: 8,
                          }}>
                            {SOURCE_ICONS[selected.source]} {SOURCE_LABELS[selected.source]} · {selected.sentiment.label.toUpperCase()} · Severity {selected.sentiment.severity}/10
                          </div>
                          <h2 style={{ fontSize: 17, fontWeight: 550, color: '#e7e5e4', margin: 0, lineHeight: 1.4 }}>
                            {selected.title}
                          </h2>
                        </div>
                        <a
                          href={selected.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            padding: '6px 12px', fontSize: 12, borderRadius: 8,
                            border: '1px solid rgba(255,255,255,0.12)',
                            color: '#9ca3af', textDecoration: 'none',
                            whiteSpace: 'nowrap', flexShrink: 0,
                          }}
                        >↗ View</a>
                      </div>

                      {selected.body && selected.body !== selected.title && (
                        <p style={{ fontSize: 13.5, color: '#a8a29e', lineHeight: 1.6, margin: '0 0 16px' }}>
                          {selected.body.slice(0, 400)}{selected.body.length > 400 ? '…' : ''}
                        </p>
                      )}

                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, color: '#78716c' }}>
                          <strong style={{ color: '#a8a29e' }}>Theme:</strong> {selected.sentiment.theme}
                        </span>
                        <span style={{ fontSize: 12, color: '#78716c' }}>
                          <strong style={{ color: '#a8a29e' }}>Author:</strong> {selected.author}
                        </span>
                        <span style={{ fontSize: 12, color: '#78716c' }}>
                          <strong style={{ color: '#a8a29e' }}>Posted:</strong> {timeAgo(selected.timestamp)}
                        </span>
                        {selected.engagement > 0 && (
                          <span style={{ fontSize: 12, color: '#78716c' }}>
                            <strong style={{ color: '#a8a29e' }}>Engagement:</strong> {selected.engagement}
                          </span>
                        )}
                      </div>

                      {(selected.sentiment.crisisWords.length > 0 || selected.sentiment.negWords.length > 0) && (
                        <div style={{ marginTop: 14, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: '#57534e', fontFamily: '"Geist Mono", monospace' }}>SIGNALS:</span>
                          {selected.sentiment.crisisWords.map(w => (
                            <span key={w} style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '2px 8px', borderRadius: 4 }}>{w}</span>
                          ))}
                          {selected.sentiment.negWords.map(w => (
                            <span key={w} style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: 'rgba(245,158,11,0.1)', color: '#fbbf24', padding: '2px 8px', borderRadius: 4 }}>{w}</span>
                          ))}
                        </div>
                      )}

                      {/* Generate video button */}
                      {(selected.sentiment.label === 'crisis' || selected.sentiment.label === 'negative') && (
                        <button
                          onClick={doGenerateScript}
                          disabled={generating}
                          style={{
                            marginTop: 18, width: '100%',
                            padding: '14px 20px',
                            background: generating ? 'rgba(239,68,68,0.3)' : 'linear-gradient(135deg, #dc2626, #b91c1c)',
                            color: '#fff', border: 'none', borderRadius: 10,
                            fontSize: 14, fontWeight: 600, cursor: generating ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {generating ? '⏳ Generating response script...' : '🎬 Generate Crisis Response Video'}
                        </button>
                      )}
                    </div>

                    {/* Script + Video Preview */}
                    {script && (
                      <div style={{
                        background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 14, padding: 24,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                          <div>
                            <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#78716c', marginBottom: 4 }}>
                              Response Video Preview
                            </div>
                            <div style={{ fontSize: 15, fontWeight: 550, color: '#e7e5e4' }}>{script.title}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: 'rgba(255,255,255,0.06)', color: '#a8a29e', padding: '4px 10px', borderRadius: 100 }}>
                              ⏱ {script.duration}
                            </span>
                            {script.usedAI && (
                              <span style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: 'rgba(34,197,94,0.1)', color: '#4ade80', padding: '4px 10px', borderRadius: 100, border: '1px solid rgba(34,197,94,0.2)' }}>
                                ✨ AI Script
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Canvas video preview */}
                        <div style={{ position: 'relative', marginBottom: 16 }}>
                          <canvas
                            ref={canvasRef}
                            width={880}
                            height={495}
                            style={{
                              width: '100%',
                              height: 'auto',
                              borderRadius: 10,
                              display: 'block',
                              border: '1px solid rgba(255,255,255,0.06)',
                            }}
                          />
                          {!speaking && (
                            <div
                              onClick={doSpeak}
                              style={{
                                position: 'absolute', inset: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'rgba(0,0,0,0.35)',
                                borderRadius: 10, cursor: 'pointer',
                              }}
                            >
                              <div style={{
                                width: 64, height: 64, borderRadius: '50%',
                                background: 'rgba(239,68,68,0.9)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 24,
                                boxShadow: '0 0 0 12px rgba(239,68,68,0.2)',
                              }}>▶</div>
                            </div>
                          )}
                        </div>

                        {/* Playback controls */}
                        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
                          {!speaking ? (
                            <button onClick={doSpeak} style={{
                              flex: 1, padding: '12px', background: '#dc2626',
                              color: '#fff', border: 'none', borderRadius: 8,
                              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                            }}>
                              ▶ Play Response Video (with Voice)
                            </button>
                          ) : (
                            <button onClick={doStop} style={{
                              flex: 1, padding: '12px', background: 'rgba(239,68,68,0.2)',
                              color: '#f87171', border: '1px solid rgba(239,68,68,0.3)',
                              borderRadius: 8, fontSize: 13, fontWeight: 600,
                              cursor: 'pointer', fontFamily: 'inherit',
                            }}>
                              ⏹ Stop
                            </button>
                          )}
                          <button
                            onClick={() => { setScript(null); setSpeaking(false); setWordIdx(0); window.speechSynthesis?.cancel(); }}
                            style={{
                              padding: '12px 16px', background: 'transparent',
                              color: '#78716c', border: '1px solid rgba(255,255,255,0.08)',
                              borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >
                            ↺ Regenerate
                          </button>
                        </div>

                        {/* Script text */}
                        <div style={{
                          background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)',
                          borderRadius: 10, padding: 20, marginBottom: 16,
                        }}>
                          <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#57534e', marginBottom: 12 }}>
                            Script
                          </div>
                          <p style={{ fontSize: 13.5, color: '#a8a29e', lineHeight: 1.75, margin: 0 }}>
                            {scriptWords.map((w, i) => (
                              <span
                                key={i}
                                style={{
                                  color: i === wordIdx ? '#f87171' : i < wordIdx ? '#e7e5e4' : '#a8a29e',
                                  fontWeight: i === wordIdx ? 600 : 400,
                                  transition: 'color 0.1s',
                                }}
                              >
                                {w}{' '}
                              </span>
                            ))}
                          </p>
                        </div>

                        {/* Key points */}
                        {script.keyPoints.length > 0 && (
                          <div>
                            <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#57534e', marginBottom: 10 }}>
                              Key Commitments
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {script.keyPoints.map((p, i) => (
                                <div key={i} style={{
                                  display: 'flex', gap: 10, alignItems: 'flex-start',
                                  background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)',
                                  borderRadius: 8, padding: '10px 14px',
                                }}>
                                  <span style={{ color: '#4ade80', flexShrink: 0, marginTop: 1 }}>→</span>
                                  <span style={{ fontSize: 13, color: '#d6d3d1', lineHeight: 1.5 }}>{p}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                          <p style={{ fontSize: 12, color: '#57534e', margin: 0 }}>
                            💡 <strong style={{ color: '#78716c' }}>Recording tip:</strong> Use your OS screen recorder (Win+G on Windows) while playing to capture this as a video for your mentor demo.
                            In production, Modal's avatar engine generates a real spokesperson video with lip-sync at ~$0.64/video.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Empty state */}
        {!result && !scanning && !error && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#57534e' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🛡️</div>
            <div style={{ fontSize: 16, marginBottom: 8, color: '#78716c' }}>Enter a brand name above to scan the internet</div>
            <div style={{ fontSize: 13 }}>Pulls live data from Reddit, Global News Database (GDELT), and Hacker News</div>
            <div style={{ marginTop: 24, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              {['OpenAI', 'Tesla', 'Paytm', 'Zomato', 'BYJU\'s', 'Zepto'].map(b => (
                <button
                  key={b}
                  onClick={() => { setBrand(b); }}
                  style={{
                    padding: '8px 16px', background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)', borderRadius: 100,
                    color: '#9ca3af', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(239,68,68,0.25); }
          50% { box-shadow: 0 0 0 8px rgba(239,68,68,0.1); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        input::placeholder { color: #57534e; }
        input:focus { border-color: rgba(239,68,68,0.5) !important; box-shadow: 0 0 0 3px rgba(239,68,68,0.1); }
      `}</style>
    </div>
  );
}
