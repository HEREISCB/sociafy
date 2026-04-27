'use client';

import React, { useState } from 'react';
import { Icon, Pglyph } from './icons';

const COMPOSE_PRESETS = [
  { id: 'thread', label: 'Thread' },
  { id: 'announce', label: 'Announcement' },
  { id: 'recap', label: 'Recap' },
  { id: 'hot_take', label: 'Hot take' },
  { id: 'lesson', label: 'Lesson' },
  { id: 'reel', label: 'Reel script' },
];

const VARIANTS = [
  {
    id: 'A',
    name: 'Variant A · Conversational',
    score: 88,
    text: "Most founders I know are spending 6+ hours a week on social — and most of it is invisible work that doesn't compound.\n\nWe built Sociafy because the cost of being absent is finally higher than the cost of being mediocre.\n\nThree things changed our approach this quarter:",
  },
  {
    id: 'B',
    name: 'Variant B · Punchy',
    score: 92,
    text: "Stop posting. Start compounding.\n\n6 hours a week → 30 minutes.\nGuesswork → signal.\nSilence → conversations.\n\nSociafy isn't a scheduler. It's the agent that runs your content brain while you build the thing.",
  },
  {
    id: 'C',
    name: 'Variant C · Story-led',
    score: 84,
    text: "Last March I missed a launch window because I forgot to schedule three posts.\n\n€48k of pipeline, gone. Not because the product wasn't ready — because I wasn't.\n\nThat's why we're shipping Sociafy. Here's what changed:",
  },
  {
    id: 'D',
    name: 'Variant D · Data-led',
    score: 79,
    text: "Founders who post 4+ times/week grow 3.2x faster than those who don't.\n\nThe problem: nobody can sustain that without burning out.\n\nWe trained an agent on 12k creator workflows to fix exactly this. Sociafy is now in private beta.",
  },
];

const PLATFORM_LIST = [
  { id: 'x', label: 'X', limit: 280 },
  { id: 'li', label: 'LinkedIn', limit: 3000 },
  { id: 'ig', label: 'Instagram', limit: 2200 },
  { id: 'fb', label: 'Facebook', limit: 5000 },
  { id: 'tt', label: 'TikTok', limit: 2200 },
];

type MediaKind = 'image' | 'carousel' | 'video';

interface MediaItem {
  kind: string;
  label: string;
  tag: string;
}

const MediaPlaceholder: React.FC<{ kind: string; ratio?: string; count?: number }> = ({ kind, ratio = '16/9', count = 1 }) => {
  if (kind === 'video') {
    return (
      <div style={{ aspectRatio: ratio, position: 'relative', background: 'repeating-linear-gradient(135deg, #181818 0 6px, #232323 6px 12px)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', display: 'grid', placeItems: 'center' }}>
          <Icon name="play" size={14} />
        </div>
        <span style={{ position: 'absolute', bottom: 6, right: 6, fontFamily: 'var(--mono)', fontSize: 9.5, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '1px 5px', borderRadius: 3 }}>0:42</span>
      </div>
    );
  }
  return (
    <div style={{ aspectRatio: ratio, position: 'relative', background: 'repeating-linear-gradient(45deg, var(--bg-sunk), var(--bg-sunk) 8px, var(--bg) 8px, var(--bg) 16px)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <Icon name="image" size={20} style={{ color: 'var(--ink-4)' }} />
      {count > 1 && <span style={{ position: 'absolute', top: 6, right: 6, fontFamily: 'var(--mono)', fontSize: 9.5, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '1px 5px', borderRadius: 3 }}>1/{count}</span>}
    </div>
  );
};

const PostX: React.FC<{ text: string; mediaKind: string }> = ({ text, mediaKind }) => (
  <div style={{ padding: '12px 14px', borderTop: '1px solid var(--line)' }}>
    <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent), oklch(0.62 0.18 30))', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 4, alignItems: 'center' }}>
          Jordan Mae <span style={{ color: 'var(--ink-4)', fontWeight: 400 }}>@jordanmae · now</span>
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.4, marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{text}</div>
        {mediaKind && (
          <div style={{ marginTop: 8, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' }}>
            <MediaPlaceholder kind={mediaKind} ratio="16/9" />
          </div>
        )}
      </div>
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ink-4)', fontSize: 11, marginLeft: 46, fontFamily: 'var(--mono)' }}>
      <span>♡ —</span><span>↻ —</span><span>💬 —</span><span>↗ —</span>
    </div>
  </div>
);

const PostLI: React.FC<{ text: string; mediaKind: string }> = ({ text, mediaKind }) => (
  <div style={{ padding: '12px 14px' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--li), #003B82)', flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Jordan Mae</div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>Founder, Sociafy</div>
        <div style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>now · 🌐</div>
      </div>
    </div>
    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>{text}</div>
    {mediaKind && <div style={{ marginTop: 10 }}><MediaPlaceholder kind={mediaKind} ratio="16/9" /></div>}
    <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 8, display: 'flex', justifyContent: 'space-around', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
      <span>👍 Like</span><span>💬 Comment</span><span>↻ Repost</span><span>↗ Send</span>
    </div>
  </div>
);

const PostIG: React.FC<{ text: string; mediaKind: string; mediaCount: number }> = ({ text, mediaKind, mediaCount }) => (
  <div>
    <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)' }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, var(--ig), #FCAF45)', flexShrink: 0 }} />
      <span style={{ fontSize: 12, fontWeight: 600 }}>jordan.mae</span>
      <span style={{ marginLeft: 'auto', color: 'var(--ink-4)' }}>•••</span>
    </div>
    <MediaPlaceholder kind={mediaKind || 'image'} ratio="1/1" count={mediaKind === 'carousel' ? mediaCount : 1} />
    <div style={{ padding: '8px 12px', display: 'flex', gap: 14, fontSize: 16 }}>
      <span>♡</span><span>💬</span><span>↗</span>
      <span style={{ marginLeft: 'auto' }}>⊟</span>
    </div>
    <div style={{ padding: '0 12px 12px', fontSize: 11.5, lineHeight: 1.4, color: 'var(--ink-2)' }}>
      <strong style={{ fontWeight: 600 }}>jordan.mae</strong> {text.slice(0, 110)}…
    </div>
  </div>
);

const PostFB: React.FC<{ text: string; mediaKind: string }> = ({ text, mediaKind }) => (
  <div style={{ padding: '12px 14px' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--fb)', flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Jordan Mae</div>
        <div style={{ fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>Just now · 🌐</div>
      </div>
    </div>
    <div style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: mediaKind ? 10 : 0 }}>{text}</div>
    {mediaKind && <MediaPlaceholder kind={mediaKind} ratio="4/3" />}
  </div>
);

const PostTT: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ position: 'relative', height: '100%', minHeight: 360, background: '#000' }}>
    <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(135deg, #111 0 8px, #181818 8px 16px)', display: 'grid', placeItems: 'center', color: '#fff8', fontFamily: 'var(--mono)', fontSize: 11 }}>
      [ vertical video ]
    </div>
    <div style={{ position: 'absolute', bottom: 60, left: 12, right: 70, color: '#fff' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>@jordan.mae</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.4, whiteSpace: 'pre-wrap', opacity: 0.95 }}>{text.slice(0, 90)}…</div>
    </div>
  </div>
);

const PhonePreview: React.FC<{ platform: string; text: string; mediaKind: string; mediaCount: number }> = ({ platform, text, mediaKind, mediaCount }) => (
  <div className="phone">
    <div className="phone-screen">
      <div className="phone-statusbar">
        <span>9:41</span>
        <div className="icons"><span>•••</span><span>◊</span><span>▮</span></div>
      </div>
      {platform === 'x' && <PostX text={text} mediaKind={mediaKind} />}
      {platform === 'li' && <PostLI text={text} mediaKind={mediaKind} />}
      {platform === 'ig' && <PostIG text={text} mediaKind={mediaKind} mediaCount={mediaCount} />}
      {platform === 'fb' && <PostFB text={text} mediaKind={mediaKind} />}
      {platform === 'tt' && <PostTT text={text} />}
    </div>
  </div>
);

const Compose: React.FC = () => {
  const [prompt, setPrompt] = useState('Announcement post for Sociafy private beta — talk about agentic content workflow, voice friendly, hopeful but grounded.');
  const [preset, setPreset] = useState('announce');
  const [active, setActive] = useState('B');
  const [platforms, setPlatforms] = useState(['x', 'li', 'ig']);
  const [previewPlat, setPreviewPlat] = useState('x');
  const [generating, setGenerating] = useState(false);
  const [mediaKind, setMediaKind] = useState<MediaKind>('image');
  const [media, setMedia] = useState<MediaItem[]>([
    { kind: 'image', label: 'Hero shot', tag: 'Generated' },
    { kind: 'image', label: 'Product detail', tag: 'Upload' },
    { kind: 'image', label: 'Behind the scenes', tag: 'Upload' },
  ]);

  const variant = VARIANTS.find((v) => v.id === active)!;
  const charCount = variant.text.length;
  const limit = PLATFORM_LIST.find((p) => p.id === previewPlat)!.limit;

  const generate = () => {
    setGenerating(true);
    setTimeout(() => setGenerating(false), 1100);
  };

  const togglePlat = (p: string) => {
    setPlatforms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  };

  return (
    <div className="composer">
      <div className="composer-left">
        <div className="prompt-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Icon name="sparkle" size={14} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 550, letterSpacing: '-0.005em' }}>Tell me what to write</span>
            <span className="chip ghost mono" style={{ marginLeft: 'auto' }}>Voice: yours · trained on 47 posts</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Write a thread about why solo founders should treat their newsletter as their #1 channel…"
          />
          <div className="prompt-foot">
            <div className="prompt-chips">
              {COMPOSE_PRESETS.map((p) => (
                <span
                  key={p.id}
                  className={`prompt-chip ${preset === p.id ? 'active' : ''}`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </span>
              ))}
            </div>
            <div className="prompt-spacer" />
            <button className="btn accent" onClick={generate}>
              {generating
                ? <><Icon name="refresh" size={12} /> Generating</>
                : <><Icon name="sparkle" size={12} /> Generate 4 variants</>}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="fork" size={14} />
              Variants
              <span className="chip ghost mono">4 generated</span>
            </h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm ghost"><Icon name="refresh" size={12} /> Regenerate</button>
              <button className="btn sm ghost"><Icon name="bolt" size={12} /> A/B test</button>
            </div>
          </div>
          <div className="card-body">
            <div className="variants">
              {VARIANTS.map((v) => (
                <div
                  key={v.id}
                  className={`variant ${active === v.id ? 'active' : ''}`}
                  onClick={() => setActive(v.id)}
                >
                  <div className="variant-head">
                    <span className="variant-name">{v.name}</span>
                    <span className="variant-meta">
                      <Icon name={v.score >= 85 ? 'fire' : 'chart'} size={11} style={{ verticalAlign: -1 }} /> {v.score}
                    </span>
                  </div>
                  <div className="variant-text">{v.text}</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm" onClick={(e) => e.stopPropagation()}><Icon name="edit" size={11} /> Refine</button>
                    <button className="btn sm" onClick={(e) => e.stopPropagation()}><Icon name="check" size={11} /> Use</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <Icon name="image" size={14} />
              Media
              <span className="chip ghost mono">{media.length} attached</span>
            </h3>
            <div className="media-tabs">
              {(['image', 'carousel', 'video'] as MediaKind[]).map((k) => (
                <span key={k} className={`opt ${mediaKind === k ? 'active' : ''}`} onClick={() => setMediaKind(k)}>
                  <Icon name={k === 'image' ? 'image' : k === 'carousel' ? 'grid' : 'play'} size={11} />
                  {k.charAt(0).toUpperCase() + k.slice(1)}
                </span>
              ))}
            </div>
          </div>
          <div className="card-body">
            {mediaKind !== 'video' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {media.filter((m) => m.kind === 'image').map((m, i) => (
                  <div key={i} style={{ aspectRatio: '1/1', position: 'relative', overflow: 'hidden', borderRadius: 10, border: '1px solid var(--line-2)', background: 'repeating-linear-gradient(135deg, var(--bg-sunk) 0 6px, var(--bg) 6px 12px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--ink-3)', cursor: 'pointer' }}>
                    <span style={{ position: 'absolute', top: 6, left: 6, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 5px', background: 'rgba(10,10,10,0.7)', color: 'white', borderRadius: 3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{m.tag}</span>
                    <button onClick={() => setMedia(media.filter((_, j) => j !== i))} style={{ position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 4, background: 'rgba(10,10,10,0.6)', color: 'white', display: 'grid', placeItems: 'center' }}>
                      <Icon name="x" size={10} />
                    </button>
                    <Icon name="image" size={22} />
                    <span style={{ fontSize: 10, fontFamily: 'var(--mono)', textAlign: 'center', padding: '0 6px', lineHeight: 1.3 }}>{m.label}</span>
                  </div>
                ))}
                <button style={{ aspectRatio: '1/1', borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--ink-3)', fontSize: 11, fontFamily: 'var(--mono)' }} onClick={() => setMedia([...media, { kind: 'image', label: 'Untitled', tag: 'Upload' }])}>
                  <Icon name="plus" size={16} />
                  <span>Upload</span>
                </button>
                <button style={{ aspectRatio: '1/1', borderRadius: 10, border: '1px dashed oklch(0.86 0.08 70)', background: 'var(--accent-soft)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--accent-ink)', fontSize: 11, fontFamily: 'var(--mono)' }} onClick={() => setMedia([...media, { kind: 'image', label: 'AI image', tag: 'Generated' }])}>
                  <Icon name="sparkle" size={16} />
                  <span>Generate</span>
                </button>
              </div>
            )}
            {mediaKind === 'video' && (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                <div style={{ aspectRatio: '16/9', position: 'relative', overflow: 'hidden', borderRadius: 10, border: '1px solid var(--ink)', background: 'repeating-linear-gradient(135deg, #181818 0 6px, #232323 6px 12px)', display: 'grid', placeItems: 'center' }}>
                  <span style={{ position: 'absolute', top: 8, left: 8, fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px', background: 'rgba(255,255,255,0.15)', color: 'white', borderRadius: 3, letterSpacing: '0.04em', textTransform: 'uppercase' }}>9:16 · 0:42</span>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: 'var(--ink)', display: 'grid', placeItems: 'center' }}>
                    <Icon name="play" size={16} />
                  </div>
                  <span style={{ position: 'absolute', bottom: 8, left: 10, fontSize: 10.5, color: 'oklch(0.85 0 0)', fontFamily: 'var(--mono)' }}>Studio tour — final cut</span>
                </div>
                <button style={{ aspectRatio: '16/9', borderRadius: 10, border: '1px dashed var(--line-2)', background: 'var(--bg-sunk)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--ink-3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <Icon name="upload" size={16} /><span>Upload clip</span>
                </button>
                <button style={{ aspectRatio: '16/9', borderRadius: 10, border: '1px dashed oklch(0.86 0.08 70)', background: 'var(--accent-soft)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--accent-ink)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <Icon name="sparkle" size={16} /><span>AI cut</span>
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 12, fontSize: 11.5, color: 'var(--ink-3)', alignItems: 'center' }}>
              <Icon name="bolt" size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span>Agent will auto-crop and resize per platform — 1:1 for Instagram, 16:9 for X, 9:16 for TikTok.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3><Icon name="globe" size={14} /> Distribution</h3>
            <span className="meta">{platforms.length} platforms · adapts per channel</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PLATFORM_LIST.map((p) => (
              <span
                key={p.id}
                className={`prompt-chip ${platforms.includes(p.id) ? 'active' : ''}`}
                onClick={() => togglePlat(p.id)}
              >
                <Pglyph p={p.id} /> {p.label}
              </span>
            ))}
            <div style={{ flex: 1 }} />
            <button className="btn sm"><Icon name="clock" size={12} /> Schedule for 14:30</button>
            <button className="btn sm primary"><Icon name="send" size={12} /> Post now</button>
          </div>
        </div>
      </div>

      <div className="composer-right">
        <div className="card">
          <div className="card-head">
            <h3><Icon name="eye" size={14} /> Live preview</h3>
            <span className="meta mono">{charCount} / {limit}</span>
          </div>
          <div className="card-body">
            <div className="preview-tabs" style={{ marginBottom: 16 }}>
              {platforms.map((p) => (
                <div
                  key={p}
                  className={`preview-tab ${previewPlat === p ? 'active' : ''}`}
                  onClick={() => setPreviewPlat(p)}
                >
                  <Pglyph p={p} />
                </div>
              ))}
            </div>
            <PhonePreview platform={previewPlat} text={variant.text} mediaKind={mediaKind} mediaCount={media.length} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Compose;
