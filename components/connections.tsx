'use client';

import React, { useState } from 'react';
import { Icon, Pglyph } from './icons';
import { apiDelete, useApi } from '../lib/ui/fetcher';
import { PLATFORM_TO_SHORT } from '../lib/ui/platforms';
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

const PLATFORMS: Array<{
  id: Platform;
  short: string;
  name: string;
  blurb: string;
  capabilities: string[];
}> = [
  {
    id: 'facebook',
    short: 'fb',
    name: 'Facebook',
    blurb: 'Post to your Facebook Page on a schedule or autopilot.',
    capabilities: ['Text posts', 'Image posts', 'Reach + engagement insights'],
  },
  {
    id: 'instagram',
    short: 'ig',
    name: 'Instagram',
    blurb: 'Publish images, carousels, and Reels to your Instagram Business account.',
    capabilities: ['Image posts', 'Carousels', 'Reels'],
  },
  {
    id: 'x',
    short: 'x',
    name: 'X (Twitter)',
    blurb: 'Tweet text + media. Threads via the agent.',
    capabilities: ['Tweets', 'Threads', 'Image tweets'],
  },
  {
    id: 'linkedin',
    short: 'li',
    name: 'LinkedIn',
    blurb: 'Publish to your LinkedIn profile.',
    capabilities: ['Text posts', 'Image posts'],
  },
  {
    id: 'tiktok',
    short: 'tt',
    name: 'TikTok',
    blurb: 'Push short-form video clips from your media library.',
    capabilities: ['Video upload via URL', 'Captions'],
  },
  {
    id: 'youtube',
    short: 'yt',
    name: 'YouTube',
    blurb: 'Connect for channel analytics; upload pipeline coming next.',
    capabilities: ['Channel discovery', 'Insights (read-only for MVP)'],
  },
];

const ConnectionsPage: React.FC = () => {
  const { data: accounts, mutate, unauth } = useApi<Account[]>('/api/accounts');
  const [busy, setBusy] = useState<string | null>(null);

  const accountFor = (p: Platform) => accounts?.find((a) => a.platform === p) ?? null;

  const connect = (p: Platform) => {
    window.location.href = `/api/oauth/${p}/start?next=/dashboard`;
  };

  const disconnect = async (id: string, name: string) => {
    if (!confirm(`Disconnect ${name}? You can reconnect anytime.`)) return;
    setBusy(id);
    try {
      await apiDelete(`/api/accounts/${id}`);
      await mutate();
    } finally {
      setBusy(null);
    }
  };

  const realCount = (accounts ?? []).filter((a) => !a.isStub).length;
  const stubCount = (accounts ?? []).filter((a) => a.isStub).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <span className="chip"><span className="dot" style={{ background: 'var(--good)' }} />{realCount} live</span>
        {stubCount > 0 && <span className="chip ghost mono">{stubCount} stub</span>}
        <span className="chip ghost mono">{PLATFORMS.length - (accounts?.length ?? 0)} available</span>
        <div style={{ flex: 1 }} />
        {unauth && (
          <a className="btn" href="/sign-in?next=/dashboard"><Icon name="bolt" size={12} /> Sign in to connect</a>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
        {PLATFORMS.map((p) => {
          const acct = accountFor(p.id);
          const live = acct && !acct.isStub;
          return (
            <div
              key={p.id}
              className="card"
              style={{
                padding: 0,
                opacity: unauth ? 0.6 : 1,
                borderColor: live ? 'var(--accent)' : 'var(--line)',
              }}
            >
              <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <Pglyph p={p.short} size="xl" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
                    {p.name}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                    {acct ? (
                      live
                        ? <>@{acct.handle ?? acct.platformUserId} {acct.meta?.pageName && <>· {acct.meta.pageName}</>}</>
                        : <>stub connection</>
                    ) : (
                      <>not connected</>
                    )}
                  </div>
                </div>
                {live
                  ? <span className="chip"><span className="dot" style={{ background: 'var(--good)' }} />Live</span>
                  : acct
                    ? <span className="chip ghost mono">stub</span>
                    : <span className="chip ghost mono">offline</span>}
              </div>

              <div style={{ padding: '14px 18px' }}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>{p.blurb}</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, marginBottom: 16 }}>
                  {p.capabilities.map((c) => (
                    <span key={c} className="chip ghost mono">{c}</span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {acct ? (
                    <>
                      <button
                        className="btn"
                        onClick={() => connect(p.id)}
                        disabled={unauth ? true : false}
                      >
                        <Icon name="refresh" size={12} /> Reconnect
                      </button>
                      <button
                        className="btn"
                        onClick={() => disconnect(acct.id, p.name)}
                        disabled={busy === acct.id || unauth}
                        style={{ color: '#b42318', borderColor: '#f4cdcd' }}
                      >
                        <Icon name="x" size={12} /> {busy === acct.id ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" onClick={() => connect(p.id)} disabled={unauth}>
                      <Icon name="arrow_right" size={12} /> Connect {p.name}
                    </button>
                  )}
                  <div style={{ flex: 1 }} />
                  {acct?.tokenExpiresAt && (
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>
                      token expires {new Date(acct.tokenExpiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 28, padding: 16, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Icon name="bolt" size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 3 }} />
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>
          Each platform&apos;s OAuth flow is handled in <span className="mono">/api/oauth/[platform]/start</span>.
          Tokens are stored encrypted-at-rest in your Postgres <span className="mono">connected_accounts</span> table.
          Disconnect anytime — your drafts and scheduled posts stay, the agent just stops being able to publish there.
        </div>
      </div>
    </>
  );
};

export default ConnectionsPage;
