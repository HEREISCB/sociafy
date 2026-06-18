'use client';

import { useState, useCallback } from 'react';

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
  source: string;
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
  sources: Record<string, number>;
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

const SOURCE_LABELS: Record<string, string> = {
  google_news: 'Google News',
  hackernews: 'Hacker News',
  wikipedia: 'Wikipedia',
};

const LABEL_CONFIG: Record<string, { bg: string; color: string; label: string }> = {
  crisis:   { bg: 'oklch(0.95 0.07 25)',  color: 'oklch(0.38 0.18 25)',  label: 'Crisis' },
  negative: { bg: 'oklch(0.96 0.06 50)',  color: 'oklch(0.42 0.14 50)',  label: 'Negative' },
  neutral:  { bg: 'oklch(0.96 0 0)',      color: '#555',                  label: 'Neutral' },
  positive: { bg: 'oklch(0.95 0.06 145)', color: 'oklch(0.38 0.12 145)', label: 'Positive' },
};

function timeAgo(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

export default function ShieldDemoPage() {
  const [brand, setBrand] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Mention | null>(null);
  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState<ScriptOutput | null>(null);

  const doScan = useCallback(async () => {
    if (!brand.trim()) return;
    setScanning(true);
    setError('');
    setResult(null);
    setSelected(null);
    setScript(null);
    try {
      const res = await fetch('/api/demo/shield/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: brand.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Scan failed');
      setResult(data);
      const first = data.mentions.find(
        (m: Mention) => m.sentiment.label === 'crisis' || m.sentiment.label === 'negative',
      ) ?? data.mentions[0] ?? null;
      setSelected(first);
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

  const filtered = result?.mentions.filter(m => filter === 'all' || m.sentiment.label === filter) ?? [];

  const counts = result
    ? {
        crisis: result.mentions.filter(m => m.sentiment.label === 'crisis').length,
        negative: result.mentions.filter(m => m.sentiment.label === 'negative').length,
        neutral: result.mentions.filter(m => m.sentiment.label === 'neutral').length,
        positive: result.mentions.filter(m => m.sentiment.label === 'positive').length,
      }
    : null;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#FAFAF7',
      color: '#0A0A0A',
      fontFamily: '"Geist", ui-sans-serif, -apple-system, system-ui, sans-serif',
    }}>
      {/* Top bar */}
      <div style={{
        borderBottom: '1px solid #E8E6E1',
        padding: '14px 32px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: '#FFFFFF',
        position: 'sticky',
        top: 0,
        zIndex: 50,
        boxShadow: '0 1px 0 rgba(10,10,10,0.04)',
      }}>
        <span style={{ fontFamily: '"Geist Mono", monospace', fontSize: 13, fontWeight: 600, letterSpacing: '-0.02em' }}>
          sociafy<span style={{ color: 'oklch(0.72 0.18 55)' }}>.</span>
        </span>
        <span style={{ width: 1, height: 18, background: '#E8E6E1' }} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>Reputation Shield</span>
        <span style={{
          marginLeft: 'auto',
          fontFamily: '"Geist Mono", monospace',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          background: 'oklch(0.96 0.06 50)',
          color: 'oklch(0.42 0.14 50)',
          border: '1px solid oklch(0.88 0.10 50)',
          padding: '3px 10px',
          borderRadius: 100,
        }}>Demo · Free APIs</span>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 32px 80px' }}>

        {/* Hero */}
        <div style={{ marginBottom: 40 }}>
          <div style={{
            fontFamily: '"Geist Mono", monospace',
            fontSize: 10.5,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'oklch(0.72 0.18 55)',
            marginBottom: 12,
          }}>
            Reputation Shield · Live Demo
          </div>
          <h1 style={{
            fontSize: 40,
            fontWeight: 500,
            letterSpacing: '-0.03em',
            margin: '0 0 10px',
            lineHeight: 1.1,
            color: '#0A0A0A',
          }}>
            What is the internet saying<br />about your brand?
          </h1>
          <p style={{ color: '#555', fontSize: 15, margin: 0, lineHeight: 1.55 }}>
            Scans Google News · Hacker News · Wikipedia — free, no API keys, live data.
          </p>
        </div>

        {/* Search bar */}
        <div style={{ display: 'flex', gap: 10, maxWidth: 640, marginBottom: 36 }}>
          <input
            type="text"
            value={brand}
            onChange={e => setBrand(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !scanning && doScan()}
            placeholder='Try "OpenAI", "Tesla", "Paytm", "Zomato"…'
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 10,
              border: '1px solid #D8D6D1',
              background: '#FFFFFF',
              color: '#0A0A0A',
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={doScan}
            disabled={scanning || !brand.trim()}
            style={{
              padding: '12px 24px',
              background: scanning ? 'oklch(0.60 0.18 55)' : 'oklch(0.72 0.18 55)',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: scanning ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
          >
            {scanning ? 'Scanning…' : 'Scan Brand'}
          </button>
        </div>

        {/* Quick-pick chips */}
        {!result && !scanning && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
            {['OpenAI', 'Tesla', 'Paytm', 'Zomato', "BYJU's", 'Zepto'].map(b => (
              <button
                key={b}
                onClick={() => setBrand(b)}
                style={{
                  padding: '6px 14px',
                  background: '#FFFFFF',
                  border: '1px solid #D8D6D1',
                  borderRadius: 100,
                  color: '#555',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'border-color 0.15s',
                }}
              >
                {b}
              </button>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            padding: '12px 16px',
            background: 'oklch(0.96 0.05 25)',
            border: '1px solid oklch(0.88 0.12 25)',
            borderRadius: 10,
            color: 'oklch(0.38 0.18 25)',
            marginBottom: 24,
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Scanning state */}
        {scanning && (
          <div style={{
            background: '#FFFFFF',
            border: '1px solid #E8E6E1',
            borderRadius: 12,
            padding: '24px 28px',
            marginBottom: 28,
          }}>
            <div style={{
              fontFamily: '"Geist Mono", monospace',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#999',
              marginBottom: 16,
            }}>
              Scanning sources for "{brand}"…
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {['Google News', 'Hacker News', 'Wikipedia'].map(src => (
                <div key={src} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 16px',
                  background: '#F4F3EE',
                  border: '1px solid #E8E6E1',
                  borderRadius: 8,
                }}>
                  <span style={{ fontSize: 13, color: '#555' }}>{src}</span>
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%',
                    border: '2px solid #D8D6D1',
                    borderTopColor: 'oklch(0.72 0.18 55)',
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
            {/* Stats */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
              <StatCard label="Total" value={result.total} />
              {(['crisis', 'negative', 'neutral', 'positive'] as const).map(lbl => (
                <StatCard
                  key={lbl}
                  label={LABEL_CONFIG[lbl].label}
                  value={counts![lbl]}
                  accent={lbl === 'crisis' && counts!.crisis > 0 ? 'oklch(0.38 0.18 25)' : undefined}
                />
              ))}
              <div style={{
                background: '#FFFFFF',
                border: '1px solid #E8E6E1',
                borderRadius: 10,
                padding: '14px 20px',
                flex: '1 1 220px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                <div style={{ fontSize: 11, color: '#999', fontFamily: '"Geist Mono", monospace', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Sources</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {Object.entries(result.sources).map(([k, v]) => (
                    <span key={k} style={{ fontSize: 12, color: '#555' }}>
                      <span style={{ fontWeight: 600, color: '#0A0A0A' }}>{v}</span> {SOURCE_LABELS[k] ?? k}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, alignItems: 'start' }}>

              {/* Left: mention list */}
              <div>
                {/* Filter pills */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                  {(['all', 'crisis', 'negative', 'neutral', 'positive'] as Filter[]).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      style={{
                        padding: '5px 12px',
                        fontSize: 12,
                        borderRadius: 100,
                        border: '1px solid',
                        borderColor: filter === f ? '#0A0A0A' : '#D8D6D1',
                        background: filter === f ? '#0A0A0A' : '#FFFFFF',
                        color: filter === f ? '#FAFAF7' : '#555',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {f === 'all' ? `All (${result.total})` : `${LABEL_CONFIG[f].label}${counts ? ` (${counts[f as keyof typeof counts]})` : ''}`}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '70vh', overflowY: 'auto' }}>
                  {filtered.length === 0 && (
                    <p style={{ color: '#999', fontSize: 13, padding: '16px 0' }}>No mentions in this category.</p>
                  )}
                  {filtered.map(m => {
                    const cfg = LABEL_CONFIG[m.sentiment.label];
                    const isSel = selected?.id === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => { setSelected(m); setScript(null); }}
                        style={{
                          textAlign: 'left',
                          background: isSel ? '#FFFFFF' : '#FAFAF7',
                          border: `1px solid ${isSel ? '#0A0A0A' : '#E8E6E1'}`,
                          borderRadius: 10,
                          padding: '13px 16px',
                          cursor: 'pointer',
                          width: '100%',
                          boxShadow: isSel ? '0 1px 0 rgba(10,10,10,0.04), 0 4px 14px -8px rgba(10,10,10,0.14)' : 'none',
                          transition: 'border-color 0.12s, box-shadow 0.12s',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{
                            fontSize: 10,
                            fontFamily: '"Geist Mono", monospace',
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            padding: '2px 8px',
                            borderRadius: 100,
                            background: cfg.bg,
                            color: cfg.color,
                            fontWeight: 700,
                          }}>
                            {cfg.label}
                          </span>
                          <span style={{ fontSize: 10, color: '#999', fontFamily: '"Geist Mono", monospace' }}>
                            {timeAgo(m.timestamp)}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#0A0A0A', lineHeight: 1.4, marginBottom: 4 }}>
                          {m.title.slice(0, 100)}{m.title.length > 100 ? '…' : ''}
                        </div>
                        <div style={{ fontSize: 11, color: '#999' }}>
                          {SOURCE_LABELS[m.source] ?? m.source}
                          {m.sentiment.severity > 0 && ` · Severity ${m.sentiment.severity}/10`}
                        </div>
                        {m.sentiment.crisisWords.length > 0 && (
                          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {m.sentiment.crisisWords.map(w => (
                              <span key={w} style={{
                                fontSize: 9.5,
                                fontFamily: '"Geist Mono", monospace',
                                background: 'oklch(0.94 0.08 25)',
                                color: 'oklch(0.38 0.18 25)',
                                padding: '1px 6px',
                                borderRadius: 4,
                                fontWeight: 600,
                              }}>{w}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right: detail + script */}
              <div>
                {!selected ? (
                  <div style={{
                    background: '#FFFFFF',
                    border: '1px dashed #D8D6D1',
                    borderRadius: 14,
                    padding: 48,
                    textAlign: 'center',
                    color: '#999',
                  }}>
                    <div style={{ fontSize: 14 }}>Select a mention to analyze and generate a response</div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Mention detail */}
                    <div style={{
                      background: '#FFFFFF',
                      border: '1px solid #E8E6E1',
                      borderRadius: 14,
                      padding: 24,
                      boxShadow: '0 1px 0 rgba(10,10,10,0.04), 0 4px 20px -12px rgba(10,10,10,0.10)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                        <div>
                          <div style={{
                            fontFamily: '"Geist Mono", monospace',
                            fontSize: 10,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            color: LABEL_CONFIG[selected.sentiment.label].color,
                            marginBottom: 8,
                          }}>
                            {SOURCE_LABELS[selected.source] ?? selected.source} · {selected.sentiment.label} · Severity {selected.sentiment.severity}/10
                          </div>
                          <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0A0A0A', margin: 0, lineHeight: 1.4 }}>
                            {selected.title}
                          </h2>
                        </div>
                        {selected.url && (
                          <a
                            href={selected.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              padding: '6px 12px',
                              fontSize: 12,
                              borderRadius: 8,
                              border: '1px solid #D8D6D1',
                              color: '#555',
                              textDecoration: 'none',
                              whiteSpace: 'nowrap',
                              flexShrink: 0,
                              alignSelf: 'flex-start',
                            }}
                          >
                            View ↗
                          </a>
                        )}
                      </div>

                      {selected.body && selected.body !== selected.title && (
                        <p style={{ fontSize: 13.5, color: '#555', lineHeight: 1.6, margin: '0 0 16px' }}>
                          {selected.body.slice(0, 400)}{selected.body.length > 400 ? '…' : ''}
                        </p>
                      )}

                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: '#999' }}>
                        <span><strong style={{ color: '#555' }}>Theme:</strong> {selected.sentiment.theme}</span>
                        <span><strong style={{ color: '#555' }}>Author:</strong> {selected.author}</span>
                        <span><strong style={{ color: '#555' }}>Posted:</strong> {timeAgo(selected.timestamp)}</span>
                        {selected.engagement > 0 && (
                          <span><strong style={{ color: '#555' }}>Engagement:</strong> {selected.engagement}</span>
                        )}
                      </div>

                      {(selected.sentiment.crisisWords.length > 0 || selected.sentiment.negWords.length > 0) && (
                        <div style={{ marginTop: 14, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: '#999', fontFamily: '"Geist Mono", monospace', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Signals:</span>
                          {selected.sentiment.crisisWords.map(w => (
                            <span key={w} style={{ fontSize: 10.5, fontFamily: '"Geist Mono", monospace', background: 'oklch(0.94 0.08 25)', color: 'oklch(0.38 0.18 25)', padding: '1px 7px', borderRadius: 4, fontWeight: 700 }}>{w}</span>
                          ))}
                          {selected.sentiment.negWords.map(w => (
                            <span key={w} style={{ fontSize: 10.5, fontFamily: '"Geist Mono", monospace', background: 'oklch(0.95 0.06 50)', color: 'oklch(0.42 0.14 50)', padding: '1px 7px', borderRadius: 4, fontWeight: 600 }}>{w}</span>
                          ))}
                        </div>
                      )}

                      {(selected.sentiment.label === 'crisis' || selected.sentiment.label === 'negative') && (
                        <button
                          onClick={doGenerateScript}
                          disabled={generating}
                          style={{
                            marginTop: 18,
                            width: '100%',
                            padding: '12px 20px',
                            background: generating ? 'oklch(0.60 0.18 55)' : 'oklch(0.72 0.18 55)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 10,
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: generating ? 'not-allowed' : 'pointer',
                            fontFamily: 'inherit',
                            letterSpacing: '-0.01em',
                          }}
                        >
                          {generating ? 'Generating response…' : 'Generate Crisis Response Script'}
                        </button>
                      )}
                    </div>

                    {/* Script output */}
                    {script && (
                      <div style={{
                        background: '#FFFFFF',
                        border: '1px solid #E8E6E1',
                        borderRadius: 14,
                        padding: 24,
                        boxShadow: '0 1px 0 rgba(10,10,10,0.04), 0 4px 20px -12px rgba(10,10,10,0.10)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
                          <div>
                            <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#999', marginBottom: 4 }}>
                              Response Script
                            </div>
                            <div style={{ fontSize: 15, fontWeight: 600, color: '#0A0A0A', letterSpacing: '-0.01em' }}>{script.title}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: '#F4F3EE', color: '#555', padding: '3px 10px', borderRadius: 100, border: '1px solid #E8E6E1' }}>
                              {script.duration}
                            </span>
                            {script.usedAI && (
                              <span style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', background: 'oklch(0.95 0.06 145)', color: 'oklch(0.38 0.12 145)', padding: '3px 10px', borderRadius: 100, border: '1px solid oklch(0.88 0.08 145)' }}>
                                AI Script
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Script text */}
                        <div style={{
                          background: '#F4F3EE',
                          border: '1px solid #E8E6E1',
                          borderRadius: 10,
                          padding: '18px 20px',
                          marginBottom: 16,
                        }}>
                          <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#999', marginBottom: 12 }}>
                            Script
                          </div>
                          <p style={{ fontSize: 13.5, color: '#0A0A0A', lineHeight: 1.75, margin: 0 }}>
                            {script.script}
                          </p>
                        </div>

                        {/* Key points */}
                        {script.keyPoints.length > 0 && (
                          <div>
                            <div style={{ fontFamily: '"Geist Mono", monospace', fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#999', marginBottom: 10 }}>
                              Key Commitments
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {script.keyPoints.map((p, i) => (
                                <div key={i} style={{
                                  display: 'flex', gap: 10, alignItems: 'flex-start',
                                  background: 'oklch(0.96 0.04 145)',
                                  border: '1px solid oklch(0.90 0.06 145)',
                                  borderRadius: 8,
                                  padding: '10px 14px',
                                }}>
                                  <span style={{ color: 'oklch(0.38 0.12 145)', flexShrink: 0 }}>→</span>
                                  <span style={{ fontSize: 13, color: '#0A0A0A', lineHeight: 1.5 }}>{p}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <div style={{ marginTop: 16, padding: '10px 14px', background: '#F4F3EE', borderRadius: 8, border: '1px solid #E8E6E1' }}>
                          <p style={{ fontSize: 12, color: '#555', margin: 0, lineHeight: 1.6 }}>
                            <strong>In production:</strong> This script is used as a prompt for a real spokesperson video generated with lip-sync at ~$0.64/video.
                            For the mentor demo, screenshot or screen-record this page.
                          </p>
                        </div>

                        <button
                          onClick={() => setScript(null)}
                          style={{
                            marginTop: 14,
                            padding: '8px 16px',
                            background: 'transparent',
                            border: '1px solid #D8D6D1',
                            borderRadius: 8,
                            fontSize: 13,
                            color: '#555',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Regenerate ↺
                        </button>
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
          <div style={{
            textAlign: 'center',
            padding: '72px 0',
            border: '1px dashed #D8D6D1',
            borderRadius: 20,
            color: '#999',
          }}>
            <div style={{ fontSize: 32, marginBottom: 14, opacity: 0.5 }}>🛡</div>
            <div style={{ fontSize: 16, marginBottom: 8, color: '#555', fontWeight: 500 }}>
              Enter a brand name to start scanning
            </div>
            <div style={{ fontSize: 13 }}>
              Pulls live data from Google News, Hacker News, and Wikipedia
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        input::placeholder { color: #999; }
        input:focus { outline: 2px solid oklch(0.72 0.18 55); outline-offset: 1px; }
      `}</style>
    </div>
  );
}

const StatCard: React.FC<{ label: string; value: number; accent?: string }> = ({ label, value, accent }) => (
  <div style={{
    background: '#FFFFFF',
    border: '1px solid #E8E6E1',
    borderRadius: 10,
    padding: '14px 20px',
    flex: '1 1 100px',
  }}>
    <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.03em', color: accent ?? '#0A0A0A', lineHeight: 1 }}>
      {value}
    </div>
    <div style={{ fontSize: 11, fontFamily: '"Geist Mono", monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#999', marginTop: 4 }}>
      {label}
    </div>
  </div>
);
