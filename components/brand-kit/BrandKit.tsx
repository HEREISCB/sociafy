'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '../icons';
import { Button, PageHeader, PinBar, Seg, useToast } from '../ui';
import { VoicePicker, useVoices } from '../voice-studio';
import { apiPatch, friendlyApiError, useApi } from '../../lib/ui/fetcher';
import {
  COLOR_ROLES, DEFAULT_FONT, GOOGLE_FONTS, brandVariables, contrastRatio, googleFontCssUrl, motionReady, resolveColors,
  type AssetRef, type BrandKit as Kit, type BrandProfile, type ColorRole, type Completeness, type FontChoice,
} from '../../lib/brand/kit';
import { BlurField, FilePick, LinesField, Segmented, uploadBrandFile } from './fields';

type Payload = { kit: Kit; profile: BrandProfile; brandKitCompleteness: Completeness; motion?: boolean };
type Patch = Record<string, unknown>;
/** One undoable save: what changed, and the PATCH that puts it back. */
type Entry = { what: string; revert: () => Promise<void> };
type Bar =
  | { state: 'saved'; at?: string }
  | { state: 'dirty' }
  | { state: 'saving'; what: string }
  | { state: 'error'; what: string; msg: string; retry: () => void };
type Ctx = {
  kit: Kit;
  profile: BrandProfile;
  /** PATCH /api/brand-kit; each section sent replaces the stored one. */
  saveKit: (patch: Patch) => Promise<Entry | null>;
  /** PATCH /api/agent/settings (name, bio, website, style guide). */
  saveProfile: (patch: Partial<BrandProfile>) => Promise<Entry | null>;
  /** Save a removal and offer Undo in a toast. */
  remove: (patch: Patch, msg: string) => void;
  /** Upload files, then save whatever `toPatch` builds from them. */
  upload: (files: File[], label: string, toPatch: (assets: AssetRef[]) => Patch) => Promise<void>;
};

// What each section looks like when it was never set, so an undo can clear it again.
const KIT_EMPTY: Patch = { tagline: '', logo: {}, colors: {}, fonts: {}, voice: {}, guidePdf: null, screenshots: [], facts: [], music: {}, video: {}, narratorVoiceId: null };
const WHAT: Record<string, string> = {
  tagline: 'tagline', logo: 'logo', colors: 'colors', fonts: 'fonts', voice: 'tone and phrases', guidePdf: 'brand guide',
  screenshots: 'product images', facts: 'key facts', music: 'music', video: 'video style', narratorVoiceId: 'narrator',
  companyName: 'brand name', brandBio: 'what you do', website: 'website', instructions: 'style guide',
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function BrandKit() {
  const { data, error, mutate } = useApi<Payload>('/api/brand-kit');
  const toast = useToast();
  const [bar, setBar] = useState<Bar>({ state: 'saved' });
  const [history, setHistory] = useState<Entry[]>([]);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  // Deep links (/settings/brand#sec-look) land after the kit loads, not before.
  const loaded = !!data;
  useEffect(() => {
    if (loaded && window.location.hash) document.querySelector(window.location.hash)?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  if (error) {
    return (
      <div className="set-page">
        <PageHeader title="Brand kit" />
        <div className="set-notice set-actions" role="alert">
          <span>Couldn’t load your brand kit.</span>
          <button className="btn sm" onClick={() => mutate()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="set-page">
        <PageHeader title="Brand kit" sub="How your posts and videos look and sound." />
        <p className="set-hint">Loading…</p>
      </div>
    );
  }

  const { kit, profile, brandKitCompleteness: done } = data;

  /** Run a save and keep the bar honest. Resolves true when it landed. */
  const run = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    setBar({ state: 'saving', what });
    try {
      await fn();
      setBar({ state: 'saved', at: stamp() });
      return true;
    } catch (e) {
      const msg = e instanceof Error && !/^\d{3}:/.test(e.message) ? e.message : friendlyApiError(e);
      setBar({ state: 'error', what, msg, retry: () => void run(what, fn) });
      return false;
    }
  };
  const kitPatch = (patch: Patch) => async () => { await mutate(await apiPatch<Payload>('/api/brand-kit', patch), { revalidate: false }); };
  const profilePatch = (patch: Patch) => async () => { await apiPatch('/api/agent/settings', patch); await mutate(); };
  const record = (what: string, revert: () => Promise<void>): Entry => {
    const entry = { what, revert };
    setHistory((h) => [...h.slice(-19), entry]);
    return entry;
  };
  // Only the keys being changed go back, so undo can't clobber another field's newer save.
  const kitBefore = (patch: Patch) => Object.fromEntries(Object.keys(patch).map((k) => [k, kit[k as keyof Kit] ?? KIT_EMPTY[k]]));
  const undo = async (entry: Entry) => {
    setHistory((h) => h.filter((e) => e !== entry));
    if (await run(entry.what, entry.revert)) toast(`Restored ${entry.what}`);
  };

  const ctx: Ctx = {
    kit,
    profile,
    saveKit: async (patch) => {
      const what = WHAT[Object.keys(patch)[0]] ?? 'brand kit';
      const before = kitBefore(patch);
      return (await run(what, kitPatch(patch))) ? record(what, kitPatch(before)) : null;
    },
    saveProfile: async (patch) => {
      const what = WHAT[Object.keys(patch)[0]] ?? 'brand profile';
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, profile[k as keyof BrandProfile] ?? '']));
      return (await run(what, profilePatch(patch))) ? record(what, profilePatch(before)) : null;
    },
    remove: async (patch, msg) => {
      const entry = await ctx.saveKit(patch);
      if (entry) toast(msg, { undo: () => void undo(entry) });
    },
    upload: async (files, label, toPatch) => {
      const out: { patch?: Patch } = {};
      const ok = await run('upload', async () => {
        const assets = await Promise.all(files.map((f) => uploadBrandFile(f, `brand:${label}`)));
        out.patch = toPatch(assets);
        await kitPatch(out.patch)();
      });
      if (ok && out.patch) record(WHAT[Object.keys(out.patch)[0]] ?? 'upload', kitPatch(kitBefore(out.patch)));
    },
  };

  const items = done.items;
  const n = (...xs: unknown[]) => xs.filter((x) => (typeof x === 'string' ? x.trim() : x)).length;
  const last = history[history.length - 1];

  return (
    <div
      className="set-page bk"
      // Typing marks the bar "unsaved"; leaving a field without a change clears it again.
      onInput={() => setBar((b) => (b.state === 'saved' ? { state: 'dirty' } : b))}
      onBlur={() => setBar((b) => (b.state === 'dirty' ? { state: 'saved', at: stamp() } : b))}
    >
      <PageHeader
        title="Brand kit"
        sub="How your posts and videos look and sound. Everything is optional; more detail means better output."
        actions={<span className="set-num">{done.done} of {done.total} set</span>}
      />
      <Unlock ctx={ctx} configured={data.motion !== false} />

      <div className="bk-wrap">
        <div className="bk-tabs">
          <Seg label="View" value={tab} onChange={setTab} options={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]} />
        </div>
        <div className="bk-grid">
          <div className="bk-col" data-off={tab === 'preview' || undefined}>
            <Section id="sec-who" title="Who you are" sub="Used in captions, end cards and video titles." n={n(profile.companyName, kit.tagline, profile.brandBio, profile.website)} of={4}>
              <IdentityEditor {...ctx} />
            </Section>
            <Section id="sec-look" title="How you look" sub="Steers images and colors your videos." n={n(items.logo, items.colors, items.fonts, items.screenshots)} of={4}>
              <LogoEditor {...ctx} />
              <ColorsEditor {...ctx} />
              <FontsEditor {...ctx} />
              <ScreenshotsEditor {...ctx} />
            </Section>
            <Section id="sec-sound" title="How you sound" sub="How every caption should read, and the only facts videos may quote." n={n(items.voice, items.facts, items.guide)} of={3}>
              <VoiceEditor {...ctx} />
              <FactsEditor {...ctx} />
              <GuideEditor {...ctx} />
            </Section>
            <Section id="sec-video" title="How your videos feel" sub="Style, soundtrack, closing line and who narrates." n={n(items.video, items.music, items.narrator)} of={3}>
              <VideoEditor {...ctx} />
              <NarratorEditor {...ctx} />
            </Section>
          </div>
          <aside className="bk-pvcol" data-off={tab === 'edit' || undefined} aria-label="Live preview">
            <Preview kit={kit} profile={profile} />
          </aside>
        </div>
      </div>

      <PinBar msg={<SaveState bar={bar} />}>
        {bar.state === 'error' && <Button size="sm" onClick={bar.retry}>Retry</Button>}
        <Button size="sm" disabled={!last || bar.state === 'saving'} onClick={() => last && void undo(last)}>
          Undo last change
        </Button>
      </PinBar>
    </div>
  );
}

function SaveState({ bar }: { bar: Bar }) {
  const text =
    bar.state === 'saving' ? `Saving ${bar.what}…`
    : bar.state === 'dirty' ? 'Unsaved: click away from the field to save'
    : bar.state === 'error' ? `Couldn’t save ${bar.what}: ${bar.msg}`
    : bar.at ? `All changes saved · ${bar.at}` : 'All changes saved';
  return (
    <span className={`bk-state is-${bar.state}`}>
      <i aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

function Section({ id, title, sub, n, of, children }: { id: string; title: string; sub: string; n: number; of: number; children: React.ReactNode }) {
  return (
    <section className="card bk-sec" id={id} aria-labelledby={`${id}-h`}>
      <div className="bk-sec-h">
        <h2 id={`${id}-h`}>{title}</h2>
        <span className="set-num">{n} of {of} set</span>
      </div>
      <p className="bk-sec-p">{sub}</p>
      <div className="bk-sec-body">{children}</div>
    </section>
  );
}

/** What the kit unlocks right now: motion graphics need a name, logo and main color. */
function Unlock({ ctx, configured }: { ctx: Ctx; configured: boolean }) {
  const { kit, profile } = ctx;
  const ready = motionReady(kit, profile);
  const missing = [!profile.companyName?.trim() && 'brand name', !kit.logo?.primary && 'logo', !kit.colors?.primary && 'main color'].filter(Boolean) as string[];
  const [was, setWas] = useState(ready);
  const [justOn, setJustOn] = useState(false);
  if (was !== ready) { setWas(ready); setJustOn(ready); }
  return (
    <div className={`bk-unlock ${ready ? 'is-on' : 'is-off'}`} role="status">
      <span className={`bk-unlock-ic${justOn ? ' is-new' : ''}`} aria-hidden="true"><Icon name={ready ? 'check' : 'lock'} size={12} /></span>
      <span className="bk-unlock-t">
        {!configured ? (
          <><b>Motion graphics</b> use your name, logo and main color: {3 - missing.length} of 3 set.</>
        ) : ready ? (
          <><b>Motion graphics are on.</b> They use your name, logo and main color.</>
        ) : (
          <><b>Motion graphics are off.</b> Add your {missing.join(', ')} to turn them on.</>
        )}
      </span>
      {!kit.logo?.primary ? (
        <FilePick primary label="Upload logo" accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp" onFiles={(f) => ctx.upload(f.slice(0, 1), 'logo-primary', ([x]) => ({ logo: { ...(kit.logo ?? {}), primary: x } }))} />
      ) : !ready ? (
        <a className="btn sm" href={!profile.companyName?.trim() ? '#sec-who' : '#sec-look'}>Add {missing[0]}</a>
      ) : null}
    </div>
  );
}

// ---- Preview ---------------------------------------------------------------

/** The kit drawn as a video end card. Re-keys on change so the new look develops in. */
function Preview({ kit, profile }: { kit: Kit; profile: BrandProfile }) {
  const { voices } = useVoices();
  const v = brandVariables(kit, profile);
  const c = resolveColors(kit.colors);
  const dark = contrastRatio('#FFFFFF', c.background) > contrastRatio('#111111', c.background);
  const logo = dark ? v.logoReverseUrl ?? v.logoUrl : v.logoUrl;
  const display = kit.fonts?.display?.family ?? DEFAULT_FONT;
  const body = kit.fonts?.body?.family ?? display;
  const fonts = [kit.fonts?.display, kit.fonts?.body].filter((f): f is FontChoice => f?.source === 'google');
  const name = profile.companyName?.trim() || 'Your brand';
  const narrator = voices.find((x) => x.id === kit.narratorVoiceId)?.name ?? 'a stock voice';
  const key = JSON.stringify([c, display, body, logo, v.tagline, name, v.cta, v.facts[0]]);
  return (
    <div className="bk-pv">
      {/* React hoists these into <head>; only the chosen families load. */}
      {fonts.map((f) => <link key={f.family} rel="stylesheet" href={googleFontCssUrl(f.family)} precedence="default" />)}
      <div className="bk-pv-lbl"><b>Live preview</b><span>End card · 9:16</span></div>
      <div key={key} className="bk-endcard bk-develop" style={{ background: c.background, color: c.text }}>
        <span className="bk-endcard-orb" style={{ background: c.secondary }} aria-hidden="true" />
        <div className="bk-endcard-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- user's logo from our bucket */}
          {logo ? <img src={logo} alt={`${name} logo`} /> : <span style={{ fontFamily: `"${display}"` }}>{name}</span>}
        </div>
        <div>
          <h3 style={{ fontFamily: `"${display}"`, color: c.primary }}>{v.tagline || name}</h3>
          {v.facts[0] && <p style={{ fontFamily: `"${body}"` }}>{v.facts[0]}</p>}
        </div>
        <span className="bk-endcard-cta" style={{ background: c.primary, color: c.background, fontFamily: `"${body}"` }}>
          {v.cta || 'Your call to action'}
        </span>
      </div>
      <span className="set-hint">
        {cap(kit.video?.style ?? 'soft')} style · {kit.music?.mood === 'none' ? 'no music' : `${kit.music?.mood ?? 'calm'} music`} · narrated by {narrator}
      </span>
    </div>
  );
}

// ---- Editors ---------------------------------------------------------------

function IdentityEditor({ kit, profile, saveKit, saveProfile }: Ctx) {
  return (
    <>
      <div className="set-grid-2">
        <BlurField label="Brand name" value={profile.companyName ?? ''} onSave={(v) => saveProfile({ companyName: v })} />
        <BlurField label="Tagline" maxLength={60} value={kit.tagline ?? ''} onSave={(v) => saveKit({ tagline: v })} />
      </div>
      <BlurField label="What you do" multiline value={profile.brandBio ?? ''} onSave={(v) => saveProfile({ brandBio: v })} />
      <BlurField
        label="Website"
        hint="We read it to learn about you, and it’s where people go next."
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

function LogoEditor({ kit, remove, upload }: Ctx) {
  const logo = kit.logo ?? {};
  return (
    <div className="set-field">
      <span className="set-label set-label--row">Logo <span className="set-hint">SVG or transparent PNG</span></span>
      <div className="bk-logos">
        {LOGO_SLOTS.map(({ key, label }) => {
          const a = logo[key];
          return (
            <div key={key} className="bk-logo">
              <span className="set-hint">{label}{key !== 'primary' && ' · optional'}</span>
              {a ? (
                <div className="bk-swatches">
                  {/* eslint-disable-next-line @next/next/no-img-element -- user's logo from our bucket, not an LCP image */}
                  <span className="bk-swatch"><img src={a.url} alt={`${label} logo on light`} loading="lazy" decoding="async" /></span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <span className="bk-swatch bk-swatch--dark"><img src={a.url} alt={`${label} logo on dark`} loading="lazy" decoding="async" /></span>
                </div>
              ) : (
                <div className="bk-swatches bk-swatches--empty"><span className="set-hint">No file yet</span></div>
              )}
              <div className="row">
                <FilePick label={a ? 'Replace' : 'Upload'} accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp" onFiles={(f) => upload(f.slice(0, 1), `logo-${key}`, ([x]) => ({ logo: { ...logo, [key]: x } }))} />
                {a && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      const next = { ...logo };
                      delete next[key];
                      remove({ logo: next }, key === 'primary' ? 'Logo removed · motion graphics need one' : `${label} logo removed`);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const COLOR_LABEL: Record<ColorRole, string> = {
  primary: 'Primary', secondary: 'Secondary', background: 'Background', text: 'Text', accent: 'Accent',
};

function ColorsEditor({ kit, saveKit }: Ctx) {
  const saved = kit.colors ?? {};
  const [draft, setDraft] = useState<Partial<Record<ColorRole, string>>>(saved);
  const [bad, setBad] = useState<ColorRole | null>(null);
  // Follow saved colors when they change underneath (Undo).
  const savedKey = JSON.stringify(saved);
  const [seen, setSeen] = useState(savedKey);
  if (seen !== savedKey) { setSeen(savedKey); setDraft(saved); }
  const commit = (role: ColorRole, raw: string) => {
    const v = raw.trim() ? (raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`).toUpperCase() : '';
    // Say what's wrong instead of silently snapping back to the old value.
    if (v && !/^#[0-9A-F]{6}$/.test(v)) return setBad(role);
    setBad((b) => (b === role ? null : b));
    if (v === (saved[role] ?? '')) return;
    const next = { ...saved };
    if (v) next[role] = v; else delete next[role];
    setDraft((d) => ({ ...d, [role]: v }));
    saveKit({ colors: next });
  };
  const resolved = resolveColors(saved);
  const ratio = contrastRatio(resolved.text, resolved.background);
  return (
    <div className="set-field">
      <span className="set-label set-label--row">
        Colors
        <span className={`set-hint${ratio < 4.5 ? ' err' : ''}`}>
          Text on background {ratio.toFixed(1)}:1 · {ratio < 4.5 ? 'aim for 4.5:1 so captions stay readable' : 'readable'}
        </span>
      </span>
      <div className="bk-colors">
        {COLOR_ROLES.map((role) => (
          <div key={role} className="bk-color">
            <span className="set-hint">{COLOR_LABEL[role]}</span>
            <label className="bk-color-in">
              <input
                type="color"
                aria-label={`${COLOR_LABEL[role]} color picker`}
                value={/^#[0-9A-F]{6}$/i.test(draft[role] ?? '') ? draft[role] : resolved[role]}
                onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value.toUpperCase() }))}
                onBlur={(e) => commit(role, e.target.value)}
              />
              <input
                className="mono"
                aria-label={`${COLOR_LABEL[role]} hex`}
                aria-invalid={bad === role || undefined}
                aria-describedby={bad === role ? 'bk-hex-err' : undefined}
                placeholder={saved[role] ? '' : `${resolved[role]} auto`}
                value={draft[role] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [role]: e.target.value }))}
                onBlur={(e) => commit(role, e.target.value)}
              />
            </label>
          </div>
        ))}
      </div>
      {bad ? (
        <p className="field-error" id="bk-hex-err"><Icon name="alert" size={12} /> {COLOR_LABEL[bad]}: use 6 hex digits, e.g. #6F4E37</p>
      ) : (
        <p className="set-hint">Leave any blank and we’ll work it out from your primary color.</p>
      )}
    </div>
  );
}

function FontsEditor(ctx: Ctx) {
  return (
    <div className="set-grid-2">
      <FontRole role="display" label="Headline font" {...ctx} />
      <FontRole role="body" label="Body font" {...ctx} />
    </div>
  );
}

function FontRole({ role, label, kit, saveKit, remove, upload }: { role: 'display' | 'body'; label: string } & Ctx) {
  const fonts = kit.fonts ?? {};
  const cur: FontChoice | undefined = fonts[role];
  const [uploading, setUploading] = useState(false);
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
        aria-label={label}
        value={cur?.source === 'google' ? cur.family : cur?.source === 'upload' ? '__upload' : ''}
        onChange={(e) => saveKit(set(e.target.value ? { source: 'google', family: e.target.value as (typeof GOOGLE_FONTS)[number] } : undefined))}
      >
        <option value="">Default (Inter)</option>
        {GOOGLE_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        {cur?.source === 'upload' && <option value="__upload" disabled>{cur.family} (uploaded)</option>}
      </select>
      {cur?.source === 'google' && (
        <>
          <link rel="stylesheet" href={googleFontCssUrl(cur.family)} precedence="default" />
          <span className="bk-font-sample" style={{ fontFamily: `"${cur.family}"` }}>The quick brown fox</span>
        </>
      )}
      <div className="row">
        <button type="button" className="btn sm ghost" aria-expanded={uploading} onClick={() => setUploading((u) => !u)}>
          <Icon name="upload" size={12} /> Upload your own
        </button>
        {cur?.source === 'upload' && (
          <button type="button" className="btn sm ghost" onClick={() => remove(set(undefined), `${cur.family} removed`)}>Remove</button>
        )}
      </div>
      {uploading && (
        <div className="stack bk-font-upload">
          {cur?.source === 'upload' && <span className="set-hint">On file: {cur.asset.name ?? cur.family}</span>}
          <input className="input" placeholder="Font name, e.g. Acme Sans" aria-label={`${label} name`} maxLength={60} value={family} onChange={(e) => setFamily(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={licensed} onChange={(e) => setLicensed(e.target.checked)} />
            <span>I have the license to use this font in videos</span>
          </label>
          <div className="row">
            <FilePick
              label={cur?.source === 'upload' ? 'Replace file' : '.woff2 or .ttf'}
              accept=".woff2,.ttf,.otf"
              disabled={!licensed || !family.trim()}
              onFiles={(f) => upload(f.slice(0, 1), `font-${role}`, ([asset]) => set({ source: 'upload', family: family.trim(), asset, licensed: true }))}
            />
            {(!licensed || !family.trim()) && <span className="set-hint">Name the font and confirm the license first.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const TONE_IDEAS = ['Warm', 'Direct', 'Playful', 'Expert', 'Bold', 'Calm', 'Witty', 'Friendly'];

function VoiceEditor({ kit, profile, saveKit, saveProfile, remove }: Ctx) {
  const voice = kit.voice ?? {};
  const tone = voice.tone ?? [];
  const full = tone.length >= 8;
  const [word, setWord] = useState('');
  const add = (w: string) => {
    const t = w.trim().slice(0, 30);
    if (t && !full && !tone.some((x) => x.toLowerCase() === t.toLowerCase())) saveKit({ voice: { ...voice, tone: [...tone, t] } });
    setWord('');
  };
  return (
    <>
      <div className="set-field">
        <span className="set-label set-label--row">Tone <span className="set-num">{tone.length} of 8</span></span>
        <div className="bk-chips">
          {tone.map((t) => (
            <span key={t} className="chip">
              {t}
              <button type="button" className="bk-chip-x" aria-label={`Remove ${t}`} onClick={() => remove({ voice: { ...voice, tone: tone.filter((x) => x !== t) } }, `Removed “${t}”`)}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          <form className="bk-chip-add" onSubmit={(e) => { e.preventDefault(); add(word); }}>
            <input
              className="input"
              placeholder={full ? '8 of 8 · remove one to add' : 'Add a word'}
              aria-label="Add a tone word"
              value={word}
              maxLength={30}
              disabled={full}
              onChange={(e) => setWord(e.target.value)}
            />
          </form>
        </div>
        <div className="bk-chips">
          {TONE_IDEAS.filter((i) => !tone.some((t) => t.toLowerCase() === i.toLowerCase())).map((i) => (
            <button key={i} type="button" className="chip ghost bk-idea" disabled={full} onClick={() => add(i)}>+ {i}</button>
          ))}
        </div>
      </div>
      <div className="set-grid-2">
        <LinesField label="Phrases we use" hint="One per line." value={voice.do ?? []} max={10} maxChars={120} onSave={(l) => saveKit({ voice: { ...voice, do: l } })} />
        <LinesField label="Phrases we never use" hint="One per line." value={voice.dont ?? []} max={10} maxChars={120} onSave={(l) => saveKit({ voice: { ...voice, dont: l } })} />
      </div>
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

function GuideEditor({ kit, remove, upload }: Ctx) {
  const pdf = kit.guidePdf;
  return (
    <div className="set-field">
      <span className="set-label set-label--row">
        Brand guide PDF
        {pdf ? <a className="set-hint" href={pdf.url} target="_blank" rel="noopener noreferrer">{pdf.name ?? 'Brand guide.pdf'}</a> : <span className="set-hint">Not set</span>}
      </span>
      <div className="row">
        <FilePick label={pdf ? 'Replace PDF' : 'Upload PDF'} accept=".pdf,application/pdf" onFiles={(f) => upload(f.slice(0, 1), 'guide', ([x]) => ({ guidePdf: x }))} />
        {pdf && <button type="button" className="btn sm ghost" onClick={() => remove({ guidePdf: null }, 'Brand guide removed')}>Remove</button>}
      </div>
      <p className="set-hint">Up to 25 MB. We keep it on file; reading it automatically is coming later.</p>
    </div>
  );
}

function ScreenshotsEditor({ kit, remove, upload }: Ctx) {
  const shots = kit.screenshots ?? [];
  const room = 8 - shots.length;
  return (
    <div className="set-field">
      <span className="set-label set-label--row">Product images <span className="set-num">{shots.length} of 8</span></span>
      {shots.length > 0 && (
        <ul className="bk-shots">
          {shots.map((s) => (
            <li key={s.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.url} alt={s.name ?? 'Product image'} loading="lazy" decoding="async" />
              <button type="button" className="icon-btn bk-shot-x" aria-label={`Remove ${s.name ?? 'image'}`} onClick={() => remove({ screenshots: shots.filter((x) => x.id !== s.id) }, 'Product image removed')}>
                <Icon name="x" size={12} />
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
        {room <= 0 && <span className="set-hint">8 of 8 · remove one to add</span>}
      </div>
    </div>
  );
}

function FactsEditor({ kit, saveKit }: Ctx) {
  return (
    <LinesField
      label="Key facts"
      hint="One short line each, e.g. “Used by 4,000 teams”. Videos only quote facts from this list."
      value={kit.facts ?? []}
      max={6}
      maxChars={140}
      onSave={(l) => saveKit({ facts: l })}
    />
  );
}

const MOODS = [
  { value: 'calm', label: 'Calm' }, { value: 'upbeat', label: 'Upbeat' },
  { value: 'cinematic', label: 'Cinematic' }, { value: 'none', label: 'None' },
] as const;
const STYLES = [{ value: 'soft', label: 'Soft' }, { value: 'bold', label: 'Bold' }] as const;

function VideoEditor({ kit, saveKit }: Ctx) {
  const video = kit.video ?? {};
  const music = kit.music ?? {};
  return (
    <>
      <div className="set-grid-2">
        <Segmented
          label="Style"
          hint={video.style === 'bold' ? 'Big type, quick cuts' : video.style === 'soft' ? 'Gentle fades, quiet type' : 'Not set'}
          value={video.style}
          options={STYLES}
          onChange={(style) => saveKit({ video: { ...video, style } })}
        />
        <Segmented label="Music" value={music.mood} options={MOODS} onChange={(mood) => saveKit({ music: { ...music, mood } })} />
      </div>
      <BlurField
        label="End card call to action"
        placeholder="e.g. Order at thirdwavebrew.in"
        maxLength={40}
        value={video.endCardCta ?? ''}
        onSave={(endCardCta) => saveKit({ video: { ...video, endCardCta } })}
      />
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

function NarratorEditor({ kit, saveKit }: Ctx) {
  const { voices } = useVoices();
  const chosen = voices.find((v) => v.id === kit.narratorVoiceId);
  return (
    <div className="set-field">
      <span className="set-label set-label--row">Narrator <Link className="set-hint" href="/settings/voice">Manage voice twins</Link></span>
      <VoicePicker value={chosen ? chosen.id : null} onChange={(id) => saveKit({ narratorVoiceId: id })} />
      <p className="set-hint">
        {chosen ? `${chosen.name} reads your videos aloud. ` : 'Videos use a stock narrator until you pick a voice twin. '}
        {kit.narratorVoiceId && !chosen && voices.length > 0 && 'The voice you picked was deleted; choose another. '}
        {kit.narratorVoiceId && (
          <button type="button" className="set-link" onClick={() => saveKit({ narratorVoiceId: null })}>Use the stock narrator</button>
        )}
      </p>
    </div>
  );
}

