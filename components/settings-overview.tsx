'use client';

import React from 'react';
import Link from 'next/link';
import { Icon, Pglyph } from './icons';
import { useApi } from '../lib/ui/fetcher';
import { PLATFORMS, PLATFORM_LABELS } from '../lib/ui/platforms';
import { accountStatus } from '../lib/ui/account-status';
import { motionReady, type BrandKit, type BrandProfile, type Completeness } from '../lib/brand/kit';
import { useNow, useOAuthReturn, type Account } from './connections-list';
import { useVoices } from './voice-studio';
import { PageHeader } from './ui';
import type { ShieldActionRow } from './shield/MentionCard';

type KitPayload = { kit: BrandKit; profile: BrandProfile; brandKitCompleteness: Completeness };
type Scheduled = { platform: string; status: string; scheduledAt: string };
type ShieldSettings = { autoFetch: boolean; autoFetchBrand: string; lastAutoFetchAt: string | null };

const WEEK = 7 * 86_400_000;

/** The GETs every settings page already makes, so the nav counts cost nothing extra (SWR dedupes). */
function useSettingsData() {
  const accounts = useApi<Account[]>('/api/accounts');
  const kit = useApi<KitPayload>('/api/brand-kit');
  const { voices, isLoading: voicesLoading } = useVoices();
  const shield = useApi<{ actions: ShieldActionRow[] }>('/api/shield/actions');
  return { accounts, kit, voices, voicesLoading, shield };
}

/** Live counts for the settings nav. */
export function useSettingsCounts() {
  const { accounts, kit, voices, shield } = useSettingsData();
  const now = useNow();
  const broken = now ? (accounts.data ?? []).filter((a) => accountStatus(a, now).broken).length : 0;
  const c = kit.data?.brandKitCompleteness;
  return {
    broken,
    kit: c ? `${c.done}/${c.total}` : '',
    voices: voices.length,
    mentions: (shield.data?.actions ?? []).filter((a) => a.status === 'pending').length,
  };
}

const ago = (iso: string, now: number) => {
  const m = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

type Need = { id: string; tone: 'bad' | 'warn'; title: string; sub: string; action: React.ReactNode };

export default function SettingsOverview() {
  const { accounts, kit, voices, voicesLoading, shield } = useSettingsData();
  const { data: scheduled } = useApi<Scheduled[]>('/api/schedule');
  const { data: shieldSettings } = useApi<{ settings: ShieldSettings }>('/api/shield/settings');
  const { flash, dismiss } = useOAuthReturn();
  const now = useNow();

  const accts = accounts.data ?? [];
  const posts = scheduled ?? [];
  const queued = (p: string) => posts.filter((s) => s.platform === p && (s.status === 'pending' || s.status === 'publishing')).length;
  const statuses = now ? accts.map((a) => ({ a, s: accountStatus(a, now, queued(a.platform)) })) : [];
  const reconnect = (p: string) => window.location.assign(`/api/oauth/${p}/start?next=${encodeURIComponent('/settings')}`);
  const pending = (shield.data?.actions ?? []).filter((a) => a.status === 'pending');
  const crisis = pending.filter((a) => a.mention.sentimentLabel === 'crisis');
  const failed = now ? posts.filter((s) => s.status === 'failed' && now - new Date(s.scheduledAt).getTime() < WEEK).length : 0;
  const k = kit.data;
  const ready = k ? motionReady(k.kit, k.profile) : true;

  const needs: Need[] = [];
  for (const { a, s } of [...statuses].sort((x, y) => x.s.rank - y.s.rank)) {
    const name = PLATFORM_LABELS[a.platform] ?? a.platform;
    const who = a.handle ? `@${a.handle.replace(/^@/, '')}` : a.displayName ?? name;
    if (s.broken) {
      needs.push({
        id: a.id, tone: a.isStub ? 'warn' : 'bad',
        title: a.isStub ? `${name} is a placeholder account` : `${name} needs reconnecting`,
        sub: `${who} · ${s.line}`,
        action: <button type="button" className="btn primary sm" onClick={() => reconnect(a.platform)}><Icon name="refresh" size={12} /> {a.isStub ? 'Connect' : 'Reconnect'}</button>,
      });
    } else if (s.soon) {
      needs.push({ id: a.id, tone: 'warn', title: `${name}: ${s.badge.toLowerCase()}`, sub: s.line, action: <button type="button" className="btn sm" onClick={() => reconnect(a.platform)}>Reconnect</button> });
    }
  }
  if (accounts.data && !accts.length) {
    needs.push({ id: 'none', tone: 'bad', title: 'No accounts connected', sub: 'Nothing can post until you connect at least one', action: <Link className="btn primary sm" href="/settings/connections">Connect an account</Link> });
  }
  if (pending.length) {
    needs.splice(statuses.filter((x) => x.s.broken && !x.a.isStub).length, 0, {
      id: 'mentions', tone: crisis.length ? 'bad' : 'warn',
      title: `${plural(pending.length, 'mention')} to review`,
      sub: crisis.length ? `${plural(crisis.length, 'crisis')} · ${ago(crisis[0].mention.fetchedAt, now)}` : 'Negative coverage, each with a reply you can draft',
      action: <Link className="btn sm" href="/settings/mentions">Review</Link>,
    });
  }
  if (failed) {
    needs.push({ id: 'failed', tone: 'warn', title: `${plural(failed, 'post')} failed this week`, sub: 'See why on Home, then retry or edit them', action: <Link className="btn sm" href="/dashboard">Open Home</Link> });
  }
  if (k && !ready) {
    const missing = [!k.profile.companyName?.trim() && 'brand name', !k.kit.logo?.primary && 'logo', !k.kit.colors?.primary && 'main color'].filter(Boolean) as string[];
    const anchor = !k.profile.companyName?.trim() ? 'sec-who' : 'sec-look';
    needs.push({ id: 'motion', tone: 'warn', title: 'Motion graphics are off', sub: `Add your ${missing.join(', ')} to turn them on`, action: <Link className="btn sm" href={`/settings/brand#${anchor}`}>Add {missing[0]}</Link> });
  }

  const loading = accounts.isLoading || kit.isLoading || shield.isLoading;
  const brokenN = statuses.filter((x) => x.s.broken).length;
  const readyVoices = voices.filter((v) => v.status === 'ready').length;
  const narrator = voices.find((v) => v.id === k?.kit.narratorVoiceId);
  const ss = shieldSettings?.settings;
  const c = k?.brandKitCompleteness;

  return (
    <div className="set-page">
      <PageHeader title="Settings" sub="What needs you, and how everything else is doing." />
      {flash && (
        <div role={flash.kind === 'success' ? 'status' : 'alert'} className={`conn-banner ${flash.kind === 'success' ? 'conn-banner--ok' : 'conn-banner--err'}`}>
          <span className="conn-banner__text">
            {flash.kind === 'success'
              ? <><strong>{PLATFORM_LABELS[flash.platform] ?? flash.platform} reconnected</strong>{flash.handle ? ` as @${flash.handle.replace(/^@/, '')}` : ''}. Queued posts will publish.</>
              : <>Couldn’t reconnect {PLATFORM_LABELS[flash.platform] ?? flash.platform}. <Link href="/settings/connections">Open Accounts</Link> to try again.</>}
          </span>
          <button type="button" className="btn ghost sm" onClick={dismiss} aria-label="Dismiss"><Icon name="x" size={12} /></button>
        </div>
      )}

      <div className="set-lbl"><b>Needs you</b><span className="set-num">{needs.length || ''}</span></div>
      <div className="card set-needs">
        {loading && !needs.length ? (
          <p className="set-needs-wait">Checking your accounts…</p>
        ) : needs.length ? (
          needs.map((n) => (
            <div key={n.id} className="set-need">
              <span className={`set-sev is-${n.tone}`} aria-hidden="true" />
              <div className="set-need-t"><b>{n.title}</b><span>{n.sub}</span></div>
              {n.action}
            </div>
          ))
        ) : (
          <div className="set-cleared">
            <span className="set-tick"><Icon name="check" size={20} /></span>
            <b>Nothing needs you</b>
            <span className="set-hint">Every account is posting and the inbox is clear.</span>
          </div>
        )}
      </div>

      <div className="set-tiles">
        <Link className="card set-tile" href="/settings/connections">
          <span className="set-tile-k">Accounts <Icon name="chevron_right" size={12} /></span>
          <span className="set-tile-v">
            {accounts.data ? <>{accts.length - brokenN} posting{brokenN ? <> · <span className="set-bad">{brokenN} broken</span></> : ''}</> : '…'}
          </span>
          <span className="set-minis">
            {PLATFORMS.map((p) => {
              const hit = statuses.find((x) => x.a.platform === p.id);
              return <Pglyph key={p.id} p={p.short} className={!hit ? 'is-off' : hit.s.broken ? 'is-bad' : undefined} />;
            })}
          </span>
        </Link>
        <Link className="card set-tile" href="/settings/brand">
          <span className="set-tile-k">Brand kit <Icon name="chevron_right" size={12} /></span>
          <span className="set-tile-v">{c ? `${c.done} of ${c.total} set` : '…'}</span>
          <span className="set-hint">{k ? (ready ? 'Motion graphics ready' : 'Motion graphics need a name, logo and main color') : ''}</span>
        </Link>
        <Link className="card set-tile" href="/settings/voice">
          <span className="set-tile-k">Voice twins <Icon name="chevron_right" size={12} /></span>
          <span className="set-tile-v">
            {voicesLoading ? '…' : voices.length ? `${readyVoices} ready${voices.length > readyVoices ? ` · ${voices.length - readyVoices} not ready` : ''}` : 'None yet'}
          </span>
          <span className="set-hint">{narrator ? `${narrator.name} narrates your videos` : 'Videos use a stock narrator'}</span>
        </Link>
        <Link className="card set-tile" href="/settings/mentions">
          <span className="set-tile-k">Mentions <Icon name="chevron_right" size={12} /></span>
          <span className="set-tile-v">{ss ? `${ss.autoFetch && ss.autoFetchBrand ? 'Watching' : 'Not scanning'} · ${pending.length} to review` : '…'}</span>
          <span className="set-hint">
            {ss?.autoFetchBrand ? `${ss.autoFetchBrand} · ${ss.lastAutoFetchAt && now ? `last scan ${ago(ss.lastAutoFetchAt, now)}` : 'no scan yet'}` : 'Add a brand to watch News, Reddit, HN and X'}
          </span>
        </Link>
      </div>
    </div>
  );
}
