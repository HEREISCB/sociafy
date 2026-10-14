'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { VoicePicker, useVoices } from '../voice-studio';
import { apiPatch, friendlyApiError, useApi } from '../../lib/ui/fetcher';
import {
  CHECKLIST, COLOR_ROLES, GOOGLE_FONTS, contrastRatio, googleFontCssUrl, resolveColors,
  type AssetRef, type BrandKit as Kit, type BrandProfile, type ChecklistItem, type ColorRole, type Completeness, type FontChoice,
} from '../../lib/brand/kit';
import { BlurField, FilePick, LinesField, Segmented, uploadBrandFile } from './fields';

type Payload = { kit: Kit; profile: BrandProfile; brandKitCompleteness: Completeness };
type SaveState = { item: ChecklistItem; state: 'saving' | 'saved' | 'error'; msg?: string } | null;
type Ctx = {
  kit: Kit;
  profile: BrandProfile;
  /** Patch kit sections (PATCH /api/brand-kit). */
  saveKit: (patch: Record<string, unknown>) => Promise<void>;
  /** Patch the agent_settings half (name, bio, website, style guide). */
  saveProfile: (patch: Partial<BrandProfile>) => Promise<void>;
  /** Upload a file, then save whatever `toPatch` builds from it. */
  upload: (files: File[], label: string, toPatch: (assets: AssetRef[]) => Record<string, unknown>) => Promise<void>;
};

const ITEMS: Record<ChecklistItem, { title: string; why: string; Editor: React.FC<Ctx>; summary: (c: Ctx) => string }> = {
  identity: {
    title: 'Name and tagline',
    why: 'Used in captions, end cards and video titles.',
    Editor: IdentityEditor,
    summary: ({ profile, kit }) => [profile.companyName, kit.tagline].filter(Boolean).join(' · '),
  },
  logo: {
    title: 'Logo',
    why: 'SVG is best; a PNG with a transparent background works too.',
    Editor: LogoEditor,
    summary: ({ kit }) => {
      const n = Object.values(kit.logo ?? {}).filter(Boolean).length;
      return n ? `${n} ${n === 1 ? 'file' : 'files'}` : '';
    },
  },
  colors: {
    title: 'Colors',
    why: 'Steers image prompts and colors your videos.',
    Editor: ColorsEditor,
    summary: ({ kit }) => Object.values(kit.colors ?? {}).filter(Boolean).join('  '),
  },
  fonts: {
    title: 'Fonts',
    why: 'Headlines and body text in your videos.',
    Editor: FontsEditor,
    summary: ({ kit }) => [kit.fonts?.display?.family, kit.fonts?.body?.family].filter(Boolean).join(' / '),
  },
  voice: {
    title: 'Brand voice',
    why: 'How every caption should sound.',
    Editor: VoiceEditor,
    summary: ({ kit }) => (kit.voice?.tone ?? []).join(', '),
  },
  guide: {
    title: 'Brand guide',
    why: 'Your PDF guidelines, kept on file.',
    Editor: GuideEditor,
    summary: ({ kit }) => kit.guidePdf?.name ?? (kit.guidePdf ? 'PDF on file' : ''),
  },
  screenshots: {
    title: 'Product images',
    why: 'Screenshots or product shots for showcase videos.',
    Editor: ScreenshotsEditor,
    summary: ({ kit }) => (kit.screenshots?.length ? `${kit.screenshots.length} of 8` : ''),
  },
  facts: {
    title: 'Key facts',
    why: 'Only facts you approve here appear in motion graphics.',
    Editor: FactsEditor,
    summary: ({ kit }) => (kit.facts?.length ? `${kit.facts.length} of 6` : ''),
  },
  music: {
    title: 'Music',
    why: 'The mood of the soundtrack under your videos.',
    Editor: MusicEditor,
    summary: ({ kit }) => kit.music?.mood ? cap(kit.music.mood) : '',
  },
  video: {
    title: 'Video style',
    why: 'Overall feel and the closing call to action.',
    Editor: VideoEditor,
    summary: ({ kit }) => [kit.video?.style && cap(kit.video.style), kit.video?.endCardCta].filter(Boolean).join(' · '),
  },
  narrator: {
    title: 'Narrator voice',
    why: 'Which voice reads your videos aloud.',
    Editor: NarratorEditor,
    summary: () => '',
  },
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function BrandKit() {
  const { data, error, mutate } = useApi<Payload>('/api/brand-kit');
  const [save, setSave] = useState<SaveState>(null);

  if (error) {
    return (
      <div className="set-notice set-actions" role="alert">
        <span>Couldn’t load your brand kit.</span>
        <button className="btn sm" onClick={() => mutate()}>Retry</button>
      </div>
    );
  }
  if (!data) return <p className="set-hint">Loading…</p>;

  const { kit, profile, brandKitCompleteness: done } = data;
  const ctxFor = (item: ChecklistItem): Ctx => {
    const run = async (fn: () => Promise<void>) => {
      setSave({ item, state: 'saving' });
      try {
        await fn();
        setSave({ item, state: 'saved' });
      } catch (e) {
        setSave({ item, state: 'error', msg: e instanceof Error && !/^\d{3}:/.test(e.message) ? e.message : friendlyApiError(e) });
      }
    };
    return {
      kit,
      profile,
      saveKit: (patch) => run(async () => { await mutate(await apiPatch<Payload>('/api/brand-kit', patch), { revalidate: false }); }),
      saveProfile: (patch) => run(async () => { await apiPatch('/api/agent/settings', patch); await mutate(); }),
      upload: (files, label, toPatch) => run(async () => {
        const assets = await Promise.all(files.map((f) => uploadBrandFile(f, `brand:${label}`)));
        await mutate(await apiPatch<Payload>('/api/brand-kit', toPatch(assets)), { revalidate: false });
      }),
    };
  };

  return (
    <div className="stack bk">
      <div className="bk-progress">
        <span className="bk-progress__label tnum">{done.done} of {done.total} done</span>
        <span className="bk-segments" aria-hidden>
          {CHECKLIST.map((k) => <span key={k} className={done.items[k] ? 'on' : undefined} />)}
        </span>
      </div>
      <div className="bk-list">
        {CHECKLIST.map((key) => {
          const meta = ITEMS[key];
          const ctx = ctxFor(key);
          const isDone = done.items[key];
          const summary = meta.summary(ctx);
          return (
            <details key={key} className="bk-item" id={`brand-${key}`}>
              <summary>
                <span className={`bk-check${isDone ? ' on' : ''}`} aria-hidden>{isDone && <Icon name="check" size={12} />}</span>
                <span className="bk-title">{meta.title}</span>
                <span className="bk-sum">{summary || meta.why}</span>
                <span className={`badge${isDone ? ' badge--ok' : ''}`}>{isDone ? 'Done' : 'Missing'}</span>
                <Icon name="chevron_down" size={14} className="bk-chev" />
              </summary>
              <div className="bk-body stack">
                {summary && <p className="set-hint">{meta.why}</p>}
                <meta.Editor {...ctx} />
                <SaveNote state={save?.item === key ? save : null} />
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function SaveNote({ state }: { state: SaveState }) {
  return (
    <p className={`bk-save${state?.state === 'error' ? ' err' : ''}`} aria-live="polite">
      {state?.state === 'saving' ? 'Saving…' : state?.state === 'saved' ? 'Saved' : state?.msg ?? ''}
    </p>
  );
}

// ---- Editors ---------------------------------------------------------------

function IdentityEditor({ kit, profile, saveKit, saveProfile }: Ctx) {
  return (
    <>
      <BlurField label="Brand name" value={profile.companyName ?? ''} onSave={(v) => saveProfile({ companyName: v })} />
      <BlurField label="Tagline" maxLength={60} value={kit.tagline ?? ''} onSave={(v) => saveKit({ tagline: v })} />
      <BlurField label="What you do" multiline value={profile.brandBio ?? ''} onSave={(v) => saveProfile({ brandBio: v })} />
      <BlurField
        label="Website"
        hint="Where people go next. We also read it to learn about you."
        type="url"
        placeholder="https://"
        value={profile.website ?? ''}
        onSave={(v) => saveProfile({ website: v && !/^https?:\/\//i.test(v) ? `https://${v}` : v })}
      />
    </>
  );
}

const LOGO_SLOTS = [
  { key: 'primary', label: 'Primary' },
  { key: 'icon', label: 'Icon / mark' },
  { key: 'reversed', label: 'Reversed, for dark backgrounds' },
  { key: 'mono', label: 'One color' },
] as const;

function LogoEditor({ kit, saveKit, upload }: Ctx) {
  const logo = kit.logo ?? {};
  return (
    <div className="bk-logos">
      {LOGO_SLOTS.map(({ key, label }) => {
        const a = logo[key];
        return (
          <div key={key} className="bk-logo">
            <span className="set-label">{label}{key !== 'primary' && <span className="opt"> · optional</span>}</span>
            {a ? (
              <div className="bk-swatches">
                {/* eslint-disable-next-line @next/next/no-img-element -- user's logo from our bucket, not an LCP image */}
                <span className="bk-swatch"><img src={a.url} alt={`${label} logo on light`} /></span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <span className="bk-swatch bk-swatch--dark"><img src={a.url} alt={`${label} logo on dark`} /></span>
              </div>
            ) : (
              <div className="bk-swatches bk-swatches--empty"><span className="set-hint">No file yet</span></div>
            )}
            <div className="row">
              <FilePick label={a ? 'Replace' : 'Upload'} accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp" onFiles={(f) => upload(f.slice(0, 1), `logo-${key}`, ([x]) => ({ logo: { ...logo, [key]: x } }))} />
              {a && (
                <button type="button" className="btn sm ghost" onClick={() => { const next = { ...logo }; delete next[key]; saveKit({ logo: next }); }}>
                  Remove
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const COLOR_LABEL: Record<ColorRole, string> = {
  primary: 'Primary', secondary: 'Secondary', background: 'Background', text: 'Text', accent: 'Accent',
};

function ColorsEditor({ kit, saveKit }: Ctx) {
  const saved = kit.colors ?? {};
  const [draft, setDraft] = useState<Partial<Record<ColorRole, string>>>(saved);
  const commit = (role: ColorRole, raw: string) => {
    const v = raw.trim() ? (raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`).toUpperCase() : '';
    if (v && !/^#[0-9A-F]{6}$/.test(v)) return setDraft((d) => ({ ...d, [role]: saved[role] }));
    if (v === (saved[role] ?? '')) return;
    const next = { ...saved };
    if (v) next[role] = v; else delete next[role];
    saveKit({ colors: next });
  };
  const resolved = resolveColors(saved);
  const ratio = contrastRatio(resolved.text, resolved.background);
  return (
    <>
      <div className="bk-colors">
        {COLOR_ROLES.map((role) => (
          <div key={role} className="bk-color">
            <span className="set-label">{COLOR_LABEL[role]}</span>
            <input
              type="color"
              aria-label={`${COLOR_LABEL[role]} color picker`}
              value={draft[role] ?? resolved[role]}
              onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value.toUpperCase() }))}
              onBlur={(e) => commit(role, e.target.value)}
            />
            <input
              className="input mono"
              aria-label={`${COLOR_LABEL[role]} hex`}
              placeholder={saved[role] ? '' : `${resolved[role]} (auto)`}
              value={draft[role] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value }))}
              onBlur={(e) => commit(role, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="row bk-contrast">
        {/* User-chosen colors: the one place raw color is rendered inline. */}
        <span className="bk-sample" style={{ background: resolved.background, color: resolved.text }}>Aa</span>
        {ratio < 4.5 ? (
          <span className="set-hint err">Text on background is {ratio.toFixed(1)}:1. Aim for at least 4.5:1 so captions stay readable.</span>
        ) : (
          <span className="set-hint">Text on background is {ratio.toFixed(1)}:1. Readable.</span>
        )}
      </div>
      <p className="set-hint">Leave any blank and we’ll work it out from your primary color.</p>
    </>
  );
}

function FontsEditor({ kit, saveKit, upload }: Ctx) {
  return (
    <>
      <FontRole role="display" label="Headlines" kit={kit} saveKit={saveKit} upload={upload} />
      <FontRole role="body" label="Body text" kit={kit} saveKit={saveKit} upload={upload} />
    </>
  );
}

function FontRole({ role, label, kit, saveKit, upload }: { role: 'display' | 'body'; label: string } & Pick<Ctx, 'kit' | 'saveKit' | 'upload'>) {
  const fonts = kit.fonts ?? {};
  const cur: FontChoice | undefined = fonts[role];
  const [mode, setMode] = useState<'google' | 'upload'>(cur?.source ?? 'google');
  const [family, setFamily] = useState(cur?.source === 'upload' ? cur.family : '');
  const [licensed, setLicensed] = useState(cur?.source === 'upload');
  const set = (next: FontChoice | undefined) => {
    const all = { ...fonts };
    if (next) all[role] = next; else delete all[role];
    return { fonts: all };
  };
  return (
    <div className="set-field bk-font">
      <span className="set-label">{label}</span>
      <select
        className="input"
        aria-label={`${label} font`}
        value={mode === 'upload' ? '__upload' : cur?.source === 'google' ? cur.family : ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__upload') return setMode('upload');
          setMode('google');
          saveKit(set(v ? { source: 'google', family: v as (typeof GOOGLE_FONTS)[number] } : undefined));
        }}
      >
        <option value="">Default (Inter)</option>
        {GOOGLE_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        <option value="__upload">Upload my own…</option>
      </select>
      {cur?.source === 'google' && (
        <>
          {/* React hoists this into <head>; it only loads the chosen family for the preview. */}
          <link rel="stylesheet" href={googleFontCssUrl(cur.family)} precedence="default" />
          <span className="bk-font-sample" style={{ fontFamily: `"${cur.family}"` }}>The quick brown fox jumps over the lazy dog</span>
        </>
      )}
      {mode === 'upload' && (
        <div className="stack bk-font-upload">
          {cur?.source === 'upload' && <span className="set-hint">On file: {cur.asset.name ?? cur.family}</span>}
          <input className="input" placeholder="Font name, e.g. Acme Sans" aria-label={`${label} font name`} maxLength={60} value={family} onChange={(e) => setFamily(e.target.value)} />
          <label className="set-check">
            <input type="checkbox" checked={licensed} onChange={(e) => setLicensed(e.target.checked)} />
            <span>I have the license to use this font in videos</span>
          </label>
          <div className="row">
            <FilePick
              label={cur?.source === 'upload' ? 'Replace file' : 'Upload .woff2 or .ttf'}
              accept=".woff2,.ttf,.otf"
              disabled={!licensed || !family.trim()}
              onFiles={(f) => upload(f.slice(0, 1), `font-${role}`, ([asset]) => set({ source: 'upload', family: family.trim(), asset, licensed: true }))}
            />
            {cur?.source === 'upload' && (
              <button type="button" className="btn sm ghost" onClick={() => { setMode('google'); saveKit(set(undefined)); }}>Remove</button>
            )}
          </div>
          {(!licensed || !family.trim()) && <span className="set-hint">Name the font and confirm the license to upload.</span>}
        </div>
      )}
    </div>
  );
}

const TONE_IDEAS = ['Warm', 'Direct', 'Playful', 'Expert', 'Bold', 'Calm', 'Witty', 'Friendly'];

function VoiceEditor({ kit, profile, saveKit, saveProfile }: Ctx) {
  const voice = kit.voice ?? {};
  const tone = voice.tone ?? [];
  const [word, setWord] = useState('');
  const setTone = (next: string[]) => saveKit({ voice: { ...voice, tone: next } });
  const add = (w: string) => {
    const t = w.trim().slice(0, 30);
    if (t && tone.length < 8 && !tone.some((x) => x.toLowerCase() === t.toLowerCase())) setTone([...tone, t]);
    setWord('');
  };
  return (
    <>
      <div className="set-field">
        <span className="set-label">Tone</span>
        <div className="bk-chips">
          {tone.map((t) => (
            <span key={t} className="chip">
              {t}
              <button type="button" className="bk-chip-x" aria-label={`Remove ${t}`} onClick={() => setTone(tone.filter((x) => x !== t))}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {tone.length < 8 && (
            <form className="bk-chip-add" onSubmit={(e) => { e.preventDefault(); add(word); }}>
              <input className="input" placeholder="Add a word" aria-label="Add a tone word" value={word} maxLength={30} onChange={(e) => setWord(e.target.value)} />
            </form>
          )}
        </div>
        {tone.length < 8 && (
          <div className="bk-chips">
            {TONE_IDEAS.filter((i) => !tone.some((t) => t.toLowerCase() === i.toLowerCase())).map((i) => (
              <button key={i} type="button" className="chip ghost bk-idea" onClick={() => add(i)}>+ {i}</button>
            ))}
          </div>
        )}
      </div>
      <LinesField label="Phrases we use" hint="One per line." value={voice.do ?? []} max={10} maxChars={120} onSave={(l) => saveKit({ voice: { ...voice, do: l } })} />
      <LinesField label="Phrases we never use" hint="One per line." value={voice.dont ?? []} max={10} maxChars={120} onSave={(l) => saveKit({ voice: { ...voice, dont: l } })} />
      <BlurField
        label="Style guide"
        hint="Anything else about how posts should sound or what they should avoid."
        multiline
        value={profile.instructions ?? ''}
        onSave={(v) => saveProfile({ instructions: v })}
      />
    </>
  );
}

function GuideEditor({ kit, saveKit, upload }: Ctx) {
  const pdf = kit.guidePdf;
  return (
    <>
      {pdf && (
        <p className="set-hint">
          <a href={pdf.url} target="_blank" rel="noopener noreferrer">{pdf.name ?? 'Brand guide.pdf'}</a>
        </p>
      )}
      <div className="row">
        <FilePick label={pdf ? 'Replace PDF' : 'Upload PDF'} accept=".pdf,application/pdf" onFiles={(f) => upload(f.slice(0, 1), 'guide', ([x]) => ({ guidePdf: x }))} />
        {pdf && <button type="button" className="btn sm ghost" onClick={() => saveKit({ guidePdf: null })}>Remove</button>}
      </div>
      <p className="set-hint">Up to 25 MB. We keep it on file; reading it automatically is coming later.</p>
    </>
  );
}

function ScreenshotsEditor({ kit, saveKit, upload }: Ctx) {
  const shots = kit.screenshots ?? [];
  const room = 8 - shots.length;
  return (
    <>
      {shots.length > 0 && (
        <ul className="bk-shots">
          {shots.map((s) => (
            <li key={s.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt={s.name ?? 'Product image'} />
              <button type="button" className="icon-btn bk-shot-x" aria-label={`Remove ${s.name ?? 'image'}`} onClick={() => saveKit({ screenshots: shots.filter((x) => x.id !== s.id) })}>
                <Icon name="trash" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <FilePick
          label="Add images"
          multiple
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          disabled={room <= 0}
          onFiles={(f) => upload(f.slice(0, room), 'screenshot', (added) => ({ screenshots: [...shots, ...added] }))}
        />
        <span className="set-hint tnum">{shots.length} of 8</span>
      </div>
    </>
  );
}

function FactsEditor({ kit, saveKit }: Ctx) {
  return (
    <LinesField
      label="Facts and stats"
      hint="One short line each, e.g. “Used by 4,000 teams”. Videos only show facts from this list."
      value={kit.facts ?? []}
      max={6}
      maxChars={140}
      onSave={(l) => saveKit({ facts: l })}
    />
  );
}

const MOODS = [
  { value: 'calm', label: 'Calm' }, { value: 'upbeat', label: 'Upbeat' },
  { value: 'cinematic', label: 'Cinematic' }, { value: 'none', label: 'No music' },
] as const;

function MusicEditor({ kit, saveKit }: Ctx) {
  const music = kit.music ?? {};
  return (
    <>
      <Segmented label="Mood" value={music.mood} options={MOODS} onChange={(mood) => saveKit({ music: { ...music, mood } })} />
      <BlurField
        label="Sounds to avoid"
        placeholder="e.g. no heavy drums, no vocals"
        maxLength={300}
        value={music.banned ?? ''}
        onSave={(banned) => saveKit({ music: { ...music, banned } })}
      />
    </>
  );
}

const STYLES = [{ value: 'soft', label: 'Soft' }, { value: 'bold', label: 'Bold' }] as const;

function VideoEditor({ kit, saveKit }: Ctx) {
  const video = kit.video ?? {};
  return (
    <>
      <Segmented label="Style" value={video.style} options={STYLES} onChange={(style) => saveKit({ video: { ...video, style } })} />
      <p className="set-hint">Soft: gentle fades and quiet type. Bold: big type, quick cuts.</p>
      <BlurField
        label="End card call to action"
        placeholder="e.g. Start free at acme.com"
        maxLength={40}
        value={video.endCardCta ?? ''}
        onSave={(endCardCta) => saveKit({ video: { ...video, endCardCta } })}
      />
    </>
  );
}

function NarratorEditor({ kit, saveKit }: Ctx) {
  const { voices } = useVoices();
  const chosen = voices.find((v) => v.id === kit.narratorVoiceId);
  return (
    <>
      <VoicePicker value={chosen ? chosen.id : null} onChange={(id) => saveKit({ narratorVoiceId: id })} />
      <p className="set-hint">
        Record or manage voices in <Link href="/settings/voice">Voice settings</Link>.
        {kit.narratorVoiceId && !chosen && voices.length > 0 && ' The voice you picked was removed; choose another.'}
      </p>
    </>
  );
}
