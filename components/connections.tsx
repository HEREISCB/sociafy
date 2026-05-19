'use client';

import React, { useEffect, useState } from 'react';
import { Icon, Pglyph } from './icons';
import { apiDelete, useApi } from '../lib/ui/fetcher';
import type { Platform } from '../lib/db/schema';

type Account = {
  id: string;
  platform: Platform;
  platformUserId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isStub: boolean;
  scope: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  meta: { pageName?: string; pageId?: string; igUserId?: string } | null;
};

type ScheduledPost = {
  id: string;
  platform: Platform;
  status: 'queued' | 'publishing' | 'published' | 'failed';
};

type PlatformDef = {
  id: Platform;
  short: 'fb' | 'ig' | 'x' | 'li' | 'tt' | 'yt';
  name: string;
  color: string;
  tagline: string;
  blurb: string;
  capabilities: string[];
};

const PLATFORMS: PlatformDef[] = [
  {
    id: 'facebook',
    short: 'fb',
    name: 'Facebook',
    color: 'var(--fb)',
    tagline: 'Pages · scheduled posts · insights',
    blurb: 'Publish to your Facebook Page on a schedule or autopilot, with engagement read-back.',
    capabilities: ['Text', 'Images', 'Insights'],
  },
  {
    id: 'instagram',
    short: 'ig',
    name: 'Instagram',
    color: 'var(--ig)',
    tagline: 'Business accounts · carousels · reels',
    blurb: 'Publish images, carousels and Reels to your Instagram Business account.',
    capabilities: ['Carousels', 'Reels', 'Stories soon'],
  },
  {
    id: 'x',
    short: 'x',
    name: 'X',
    color: 'var(--x)',
    tagline: 'Tweets · threads · image posts',
    blurb: 'Tweet text and media. Threads orchestrated by the agent when you want a series.',
    capabilities: ['Tweets', 'Threads', 'Media'],
  },
  {
    id: 'linkedin',
    short: 'li',
    name: 'LinkedIn',
    color: 'var(--li)',
    tagline: 'Member profile · share commentary',
    blurb: 'Publish to your LinkedIn profile with member-network visibility.',
    capabilities: ['Text', 'Images', 'Links'],
  },
  {
    id: 'tiktok',
    short: 'tt',
    name: 'TikTok',
    color: 'var(--tt)',
    tagline: 'Direct video uploads via URL',
    blurb: 'Push short-form video clips straight from your media library.',
    capabilities: ['Video', 'Captions'],
  },
  {
    id: 'youtube',
    short: 'yt',
    name: 'YouTube',
    color: 'var(--yt)',
    tagline: 'Channel discovery · analytics',
    blurb: 'Connect for channel analytics. Resumable upload pipeline coming next.',
    capabilities: ['Channel', 'Analytics'],
  },
];

const DAY = 86_400_000;

type Health = {
  status: 'live' | 'expiring' | 'expired' | 'persistent' | 'stub' | 'offline';
  label: string;
  detail: string;
  pct: number; // 0-100 fill for the bar
  tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent';
};

function healthFor(acct: Account | null): Health {
  if (!acct) return { status: 'offline', label: 'Not connected', detail: '—', pct: 0, tone: 'neutral' };
  if (acct.isStub) return { status: 'stub', label: 'Stub', detail: 'placeholder credentials', pct: 100, tone: 'warn' };
  if (!acct.tokenExpiresAt) {
    return { status: 'persistent', label: 'Long-lived', detail: 'token does not expire', pct: 100, tone: 'good' };
  }
  const now = Date.now();
  const exp = new Date(acct.tokenExpiresAt).getTime();
  const diff = exp - now;
  if (diff <= 0) return { status: 'expired', label: 'Token expired', detail: 'reconnect to resume publishing', pct: 100, tone: 'bad' };
  const days = Math.floor(diff / DAY);
  const hrs = Math.floor((diff % DAY) / 3_600_000);
  const detail =
    days >= 1
      ? `expires in ${days}d ${hrs}h`
      : diff > 3_600_000
      ? `expires in ${hrs}h ${Math.floor((diff % 3_600_000) / 60_000)}m`
      : `expires in ${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < 24 * 3_600_000) {
    const pct = Math.max(8, Math.min(100, (diff / (24 * 3_600_000)) * 100));
    return { status: 'expiring', label: 'Refresh soon', detail, pct, tone: 'warn' };
  }
  // 60-day reference window for live bar fill
  const SIXTY = 60 * DAY;
  const pct = Math.max(12, Math.min(100, (diff / SIXTY) * 100));
  return { status: 'live', label: 'Connected', detail, pct, tone: 'accent' };
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < DAY * 30) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const toneColor: Record<Health['tone'], string> = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  accent: 'var(--accent)',
  neutral: 'var(--ink-4)',
};

type Flash =
  | { kind: 'success'; platform: string; handle: string | null }
  | { kind: 'error'; platform: string; detail: string };

const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const ConnectionsPage: React.FC = () => {
  const { data: accounts, mutate, unauth } = useApi<Account[]>('/api/accounts');
  const { data: scheduled } = useApi<ScheduledPost[]>('/api/schedule');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const errorDetail = params.get('oauth_error');
    const platform = params.get('platform') ?? connected;
    if (connected) {
      setFlash({ kind: 'success', platform: connected, handle: params.get('handle') });
      void mutate();
    } else if (errorDetail && platform) {
      setFlash({ kind: 'error', platform, detail: errorDetail });
    }
    if (connected || errorDetail) {
      params.delete('connected');
      params.delete('handle');
      params.delete('oauth_error');
      params.delete('platform');
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : '');
      window.history.replaceState(null, '', url);
    }
  }, [mutate]);

  useEffect(() => {
    if (flash?.kind !== 'success') return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  const accountFor = (p: Platform) => accounts?.find((a) => a.platform === p) ?? null;

  const connect = (p: Platform) => {
    const next = encodeURIComponent('/dashboard?tab=connections');
    window.location.href = `/api/oauth/${p}/start?next=${next}`;
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      await apiDelete(`/api/accounts/${id}`);
      await mutate();
      setConfirmId(null);
    } finally {
      setBusy(null);
    }
  };

  const live = (accounts ?? []).filter((a) => !a.isStub);
  const stubs = (accounts ?? []).filter((a) => a.isStub);
  const expiring = live.filter((a) => {
    if (!a.tokenExpiresAt) return false;
    const diff = new Date(a.tokenExpiresAt).getTime() - Date.now();
    return diff > 0 && diff < 24 * 3_600_000;
  });
  const expired = live.filter((a) => {
    if (!a.tokenExpiresAt) return false;
    return new Date(a.tokenExpiresAt).getTime() - Date.now() <= 0;
  });

  const publishedByPlatform = new Map<Platform, number>();
  const queuedByPlatform = new Map<Platform, number>();
  (scheduled ?? []).forEach((s) => {
    if (s.status === 'published') publishedByPlatform.set(s.platform, (publishedByPlatform.get(s.platform) ?? 0) + 1);
    if (s.status === 'queued' || s.status === 'publishing') queuedByPlatform.set(s.platform, (queuedByPlatform.get(s.platform) ?? 0) + 1);
  });
  const totalPublished = Array.from(publishedByPlatform.values()).reduce((a, b) => a + b, 0);

  return (
    <>
      {/* Hero strip */}
      <div
        style={{
          background: 'var(--ink)',
          color: 'var(--bg)',
          borderRadius: 'var(--r-lg)',
          padding: '22px 26px',
          marginBottom: 24,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 92% 8%, oklch(0.42 0.16 55 / 0.45), transparent 55%), radial-gradient(circle at 4% 110%, oklch(0.34 0.12 220 / 0.32), transparent 60%)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', gap: 28, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'oklch(0.72 0.18 55)',
                marginBottom: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  boxShadow: '0 0 0 4px oklch(0.42 0.16 55 / 0.35)',
                }}
              />
              05 / Connections
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 32,
                fontWeight: 500,
                letterSpacing: '-0.025em',
                lineHeight: 1.1,
              }}
            >
              Where Sociafy posts{' '}
              <em style={{ color: 'var(--accent)', fontStyle: 'normal' }}>on your behalf.</em>
            </h1>
            <p
              style={{
                margin: '12px 0 0',
                fontSize: 13.5,
                lineHeight: 1.55,
                color: 'oklch(0.78 0 0)',
                maxWidth: 56,
                maxInlineSize: '52ch',
              }}
            >
              Connect each platform once. Tokens are encrypted at rest, refresh in the background, and you can pull the plug anytime — drafts and queue survive disconnects.
            </p>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, auto)',
              gap: '14px 32px',
              alignItems: 'flex-end',
              padding: '6px 0',
            }}
          >
            <StatCell label="Live" value={live.length} sub={`of ${PLATFORMS.length} platforms`} />
            <StatCell label="Posts shipped" value={totalPublished} sub="across all channels" />
            <StatCell
              label="Needs attention"
              value={expiring.length + expired.length + stubs.length}
              sub={expired.length ? `${expired.length} expired` : expiring.length ? `${expiring.length} expiring <24h` : stubs.length ? `${stubs.length} stub` : 'all healthy'}
              warn={expired.length > 0 || expiring.length > 0}
            />
          </div>
        </div>
      </div>

      {flash && <FlashBanner flash={flash} onDismiss={() => setFlash(null)} />}

      {unauth && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: 'var(--bg-elev)',
            border: '1px dashed var(--line-2)',
            borderRadius: 10,
            marginBottom: 18,
          }}
        >
          <Icon name="lock" size={14} />
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Sign in to connect or disconnect accounts.</span>
          <div style={{ flex: 1 }} />
          <a className="btn primary" href="/sign-in?next=/dashboard">
            <Icon name="arrow_right" size={12} /> Sign in
          </a>
        </div>
      )}

      {/* Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap: 16,
          alignItems: 'stretch',
        }}
      >
        {PLATFORMS.map((p) => {
          const acct = accountFor(p.id);
          const health = healthFor(acct);
          const isLive = health.status === 'live' || health.status === 'persistent' || health.status === 'expiring';
          const published = publishedByPlatform.get(p.id) ?? 0;
          const queued = queuedByPlatform.get(p.id) ?? 0;
          const confirming = confirmId === acct?.id;

          return (
            <article
              key={p.id}
              style={{
                position: 'relative',
                background: 'var(--bg-elev)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-lg)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                opacity: unauth ? 0.55 : 1,
                transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
                boxShadow: isLive ? '0 1px 0 rgba(10,10,10,0.04), 0 12px 32px -16px rgba(10,10,10,0.12)' : 'var(--shadow-1)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 4px 6px rgba(10,10,10,0.04), 0 18px 40px -16px rgba(10,10,10,0.18)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = isLive
                  ? '0 1px 0 rgba(10,10,10,0.04), 0 12px 32px -16px rgba(10,10,10,0.12)'
                  : 'var(--shadow-1)';
              }}
            >
              {/* Platform color stripe */}
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  background: p.color,
                  opacity: isLive ? 1 : 0.35,
                }}
              />

              {/* Header — tinted with platform color when connected */}
              <header
                style={{
                  padding: '16px 16px 14px 22px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  background: isLive
                    ? `linear-gradient(180deg, color-mix(in oklab, ${p.color} 9%, transparent), transparent 80%)`
                    : 'transparent',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <Pglyph p={p.short} size="xl" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <h3
                      style={{
                        margin: 0,
                        fontSize: 17,
                        fontWeight: 600,
                        letterSpacing: '-0.015em',
                        lineHeight: 1.2,
                      }}
                    >
                      {p.name}
                    </h3>
                    <StatusBadge health={health} />
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      color: 'var(--ink-3)',
                      marginTop: 4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {acct
                      ? acct.handle
                        ? `@${acct.handle.replace(/^@/, '')}`
                        : acct.displayName || acct.platformUserId
                      : p.tagline}
                    {acct?.meta?.pageName && (
                      <span style={{ color: 'var(--ink-4)' }}> · {acct.meta.pageName}</span>
                    )}
                  </div>
                </div>
                {acct && !unauth && (
                  <button
                    className="btn ghost sm"
                    title="Disconnect"
                    onClick={() => setConfirmId(confirmId === acct.id ? null : acct.id)}
                    style={{
                      padding: '4px 6px',
                      color: confirmId === acct.id ? 'var(--bad)' : 'var(--ink-4)',
                    }}
                  >
                    <Icon name="more" size={14} />
                  </button>
                )}
              </header>

              {/* Body — unified, ends with full-width action button */}
              <div style={{ padding: '16px 18px 16px 22px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
                {acct && !acct.isStub ? (
                  // CONNECTED layout: status data first, then action
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: 11,
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            fontSize: 10,
                            color: 'var(--ink-3)',
                          }}
                        >
                          Token
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            color: toneColor[health.tone],
                            fontWeight: 600,
                          }}
                        >
                          {health.status === 'persistent' ? 'no expiry · auto-refresh' : health.detail}
                        </span>
                      </div>
                      <div
                        style={{
                          height: 4,
                          borderRadius: 999,
                          background: 'var(--bg-sunk)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${health.pct}%`,
                            background: toneColor[health.tone],
                            borderRadius: 999,
                            transition: 'width 0.4s ease',
                            opacity: health.status === 'expired' ? 0.45 : 1,
                          }}
                        />
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1px 1fr',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--r-sm)',
                        background: 'var(--bg-sunk)',
                      }}
                    >
                      <StatBlock label="Published" value={published} mono />
                      <div style={{ background: 'var(--line)' }} />
                      <StatBlock label="In queue" value={queued} mono accent={queued > 0} />
                    </div>

                    {confirming ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                        <button
                          className="btn"
                          onClick={() => setConfirmId(null)}
                          disabled={busy === acct.id}
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn"
                          onClick={() => disconnect(acct.id)}
                          disabled={busy === acct.id}
                          style={{
                            flex: 1,
                            justifyContent: 'center',
                            background: 'var(--bad)',
                            borderColor: 'var(--bad)',
                            color: 'white',
                          }}
                        >
                          {busy === acct.id ? 'Removing…' : `Disconnect ${p.name}`}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn"
                        onClick={() => connect(p.id)}
                        disabled={unauth}
                        style={{
                          width: '100%',
                          justifyContent: 'center',
                          padding: '9px 12px',
                          marginTop: 'auto',
                          background: health.status === 'expired' || health.status === 'expiring' ? 'var(--ink)' : 'var(--bg-elev)',
                          color: health.status === 'expired' || health.status === 'expiring' ? 'var(--bg)' : 'var(--ink)',
                          borderColor: health.status === 'expired' || health.status === 'expiring' ? 'var(--ink)' : 'var(--line)',
                        }}
                      >
                        <Icon name="refresh" size={12} />{' '}
                        {health.status === 'expired' ? 'Reconnect now' : 'Reconnect'}
                      </button>
                    )}

                  </>
                ) : (
                  // NOT CONNECTED / STUB layout
                  <>
                    <p
                      style={{
                        margin: 0,
                        fontSize: 13,
                        color: 'var(--ink-2)',
                        lineHeight: 1.55,
                      }}
                    >
                      {p.blurb}
                    </p>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {p.capabilities.map((c) => (
                        <span
                          key={c}
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            padding: '2px 8px',
                            borderRadius: 100,
                            background: 'transparent',
                            border: '1px solid var(--line)',
                            color: 'var(--ink-2)',
                            letterSpacing: '-0.01em',
                          }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>

                    {acct?.isStub && confirming ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
                        <button
                          className="btn"
                          onClick={() => setConfirmId(null)}
                          disabled={busy === acct.id}
                          style={{ flex: 1, justifyContent: 'center' }}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn"
                          onClick={() => disconnect(acct.id)}
                          disabled={busy === acct.id}
                          style={{
                            flex: 1,
                            justifyContent: 'center',
                            background: 'var(--bad)',
                            borderColor: 'var(--bad)',
                            color: 'white',
                          }}
                        >
                          {busy === acct.id ? 'Removing…' : 'Disconnect'}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn primary"
                        onClick={() => connect(p.id)}
                        disabled={unauth}
                        style={{
                          width: '100%',
                          justifyContent: 'center',
                          padding: '9px 12px',
                          marginTop: 'auto',
                        }}
                      >
                        Connect {p.name} <Icon name="arrow_right" size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* Help row */}
      <div
        style={{
          marginTop: 28,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 14,
        }}
      >
        <HelpCell
          icon="lock"
          title="Encrypted at rest"
          body="Tokens live in your Postgres connected_accounts table. Disconnect anytime — nothing else gets deleted."
        />
        <HelpCell
          icon="refresh"
          title="Background refresh"
          body="Long-lived tokens auto-refresh. Short-lived ones (like X) refresh via the agent loop."
        />
        <HelpCell
          icon="bolt"
          title="One flow, one URL"
          body={
            <>
              Every platform routes through{' '}
              <span className="mono" style={{ fontSize: 11 }}>
                /api/oauth/[platform]/start
              </span>
              .
            </>
          }
        />
      </div>
    </>
  );
};

const FlashBanner: React.FC<{ flash: Flash; onDismiss: () => void }> = ({ flash, onDismiss }) => {
  const isSuccess = flash.kind === 'success';
  const label = PLATFORM_LABELS[flash.platform] ?? flash.platform;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px 12px 16px',
        marginBottom: 18,
        borderRadius: 12,
        border: `1px solid ${isSuccess ? 'oklch(0.78 0.14 155 / 0.45)' : 'oklch(0.72 0.18 25 / 0.45)'}`,
        background: isSuccess ? 'oklch(0.96 0.05 155)' : 'oklch(0.97 0.05 25)',
        color: isSuccess ? 'oklch(0.32 0.10 155)' : 'oklch(0.36 0.16 25)',
        boxShadow: '0 1px 0 rgba(10,10,10,0.04), 0 12px 32px -22px rgba(10,10,10,0.18)',
        animation: 'fadeSlideIn 220ms ease-out',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: isSuccess ? 'oklch(0.62 0.16 155)' : 'oklch(0.60 0.20 25)',
          color: 'white',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <Icon name={isSuccess ? 'check' : 'alert'} size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>
          {isSuccess
            ? `${label} connected`
            : `Couldn't connect ${label}`}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            marginTop: 2,
            opacity: 0.85,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {isSuccess
            ? flash.handle
              ? `Signed in as @${flash.handle.replace(/^@/, '')} · tokens stored, ready to post`
              : 'Tokens stored, ready to post'
            : flash.detail}
        </div>
      </div>
      <button
        onClick={onDismiss}
        title="Dismiss"
        className="btn ghost sm"
        style={{
          padding: '4px 8px',
          color: 'inherit',
          opacity: 0.7,
          background: 'transparent',
          border: 'none',
        }}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
};

const StatCell: React.FC<{ label: string; value: number; sub: string; warn?: boolean }> = ({
  label,
  value,
  sub,
  warn,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 92 }}>
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: warn ? 'var(--warn)' : 'oklch(0.7 0 0)',
      }}
    >
      {label}
    </span>
    <span
      className="mono"
      style={{
        fontSize: 30,
        fontWeight: 500,
        letterSpacing: '-0.03em',
        lineHeight: 1,
        color: warn ? 'var(--warn)' : 'var(--bg)',
      }}
    >
      {String(value).padStart(2, '0')}
    </span>
    <span
      style={{
        fontSize: 11,
        color: 'oklch(0.62 0 0)',
        marginTop: 2,
        fontFamily: 'var(--mono)',
      }}
    >
      {sub}
    </span>
  </div>
);

const StatusBadge: React.FC<{ health: Health }> = ({ health }) => {
  const dotColor = toneColor[health.tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10.5,
        fontFamily: 'var(--mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        padding: '2px 8px 2px 6px',
        borderRadius: 100,
        background:
          health.tone === 'accent'
            ? 'oklch(0.96 0.04 70)'
            : health.tone === 'good'
            ? 'oklch(0.95 0.04 155)'
            : health.tone === 'warn'
            ? 'oklch(0.96 0.05 75)'
            : health.tone === 'bad'
            ? 'oklch(0.94 0.06 25)'
            : 'var(--bg-sunk)',
        color:
          health.tone === 'accent'
            ? 'var(--accent-ink)'
            : health.tone === 'good'
            ? 'oklch(0.36 0.10 155)'
            : health.tone === 'warn'
            ? 'oklch(0.40 0.14 75)'
            : health.tone === 'bad'
            ? 'oklch(0.38 0.16 25)'
            : 'var(--ink-3)',
        border: '1px solid transparent',
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: health.tone === 'accent' || health.tone === 'good' ? `0 0 0 3px ${dotColor}30` : 'none',
        }}
      />
      {health.label}
    </span>
  );
};

const StatBlock: React.FC<{ label: string; value: number; mono?: boolean; accent?: boolean }> = ({
  label,
  value,
  mono,
  accent,
}) => (
  <div
    style={{
      padding: '10px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}
  >
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--ink-4)',
      }}
    >
      {label}
    </span>
    <span
      className={mono ? 'mono' : ''}
      style={{
        fontSize: 18,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: accent ? 'var(--accent-ink)' : 'var(--ink)',
        lineHeight: 1,
      }}
    >
      {value}
    </span>
  </div>
);

const HelpCell: React.FC<{ icon: 'lock' | 'refresh' | 'bolt'; title: string; body: React.ReactNode }> = ({
  icon,
  title,
  body,
}) => (
  <div
    style={{
      padding: '14px 16px',
      background: 'var(--bg-elev)',
      border: '1px solid var(--line)',
      borderRadius: 10,
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
    }}
  >
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: 'var(--bg-sunk)',
        border: '1px solid var(--line)',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--accent-ink)',
        flexShrink: 0,
      }}
    >
      <Icon name={icon} size={14} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <strong style={{ fontSize: 12.5, letterSpacing: '-0.005em' }}>{title}</strong>
      <span style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5 }}>{body}</span>
    </div>
  </div>
);

export default ConnectionsPage;
