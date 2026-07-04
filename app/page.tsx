'use client';

import React from 'react';
import Link from 'next/link';
import { TIER_PRICING, TOPUP_PRICING, type Currency } from '../lib/billing/pricing';

const ArrowIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const SparkleIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
    <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z" />
  </svg>
);

const LockIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
);

const PG = ({ k }: { k: string }) => (
  <span className={`pglyph ${k}`} aria-hidden="true">
    {({ ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y', th: '@' } as Record<string, string>)[k]}
  </span>
);

const SkipLink = () => {
  const [focused, setFocused] = React.useState(false);
  return (
    <a
      href="#main"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        focused
          ? {
              position: 'fixed',
              top: 12,
              left: 12,
              zIndex: 1000,
              background: 'var(--ink)',
              color: 'var(--bg)',
              padding: '10px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontFamily: 'var(--sans)',
              textDecoration: 'none',
            }
          : {
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }
      }
    >
      Skip to content
    </a>
  );
};

const LPNav = () => (
  <header className="lp-nav-wrap">
    <div className="lp lp-nav">
      <Link href="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }} aria-label="Sociafy home">
        <div className="brand-mark" aria-hidden="true">S</div>
        <div className="brand-name">Sociafy<span className="dot">.</span></div>
      </Link>
      <nav className="lp-nav-links" aria-label="Primary">
        <a href="#agent">Agent</a>
        <a href="#workflow">Workflow</a>
        <a href="#voice">Voice</a>
        <a href="#pricing">Pricing</a>
      </nav>
      <div className="lp-nav-spacer" />
      <div className="lp-nav-actions">
        <span className="lp-nav-status"><span className="dot" /> Built for founders who&apos;d rather be building</span>
        <Link className="btn" href="/sign-in">Log in</Link>
        <Link className="btn primary" href="/sign-up">
          Start now <ArrowIcon />
        </Link>
      </div>
    </div>
  </header>
);

const Hero = ({ currency }: { currency: Currency }) => (
  <section className="hero">
    <div className="lp">
      <div className="hero-grid">
        <div>
          <span className="hero-eyebrow">
            <span className="pill">NEW</span>
            Voice-trained AI agent
            <span className="arrow">→</span>
          </span>
          <h1>
            Your social presence,{' '}
            <em>without</em> the second <span className="accent">full-time job</span>.
          </h1>
          <p className="hero-lede">
            Sociafy is an AI agent that learns your voice, watches your niche, and
            ships posts on every platform — while you keep building. You stay in
            the loop. The grind doesn&apos;t.
          </p>
          <div className="hero-cta">
            <Link className="btn btn-lg primary" href="/sign-up">
              <SparkleIcon /> Start now
            </Link>
            <a className="btn btn-lg" href="#agent">
              <SparkleIcon /> Build agents
            </a>
          </div>
          <div className="hero-meta">
            <span className="dotted">From {tierPrice(currency, 'starter')} / month</span>
            <span className="dotted">Cancel anytime</span>
            <span className="dotted">No free trial</span>
          </div>
        </div>

        <aside className="hero-side">
          <div className="hero-side-head">
            <span className="agent-mark" aria-hidden="true">S</span>
            <span>Agent feed · live</span>
            <span className="live"><span className="pulse" /> watching</span>
          </div>

          <div className="feed-row">
            <span className="ts">2 min ago · trend</span>
            <div className="body">
              <strong>Spotted a rising trend</strong> in <em>&quot;agentic content&quot;</em>.
              It lines up with the topics your audience engages with most.
            </div>
          </div>
          <div className="feed-row">
            <span className="ts">14 min ago · drafts</span>
            <div className="body">
              Drafted <strong>a few angles</strong> from your latest newsletter.
              Variant B matched your voice best.
            </div>
          </div>
          <div className="feed-row">
            <span className="ts">1 hr ago · held</span>
            <div className="body">
              Held a LinkedIn draft — flagged <em>&quot;game-changing&quot;</em>.
              Rewrote it and queued for approval.
            </div>
          </div>

          <div className="hero-side-foot">
            <Link className="btn accent" href="/sign-up">Review drafts</Link>
            <a className="btn" href="#workflow">See full briefing</a>
          </div>
        </aside>
      </div>
    </div>

    <div className="lp">
      <div className="lp-logos">
        <div className="lp-logos-label">Built for solo founders, indie studios &amp; small marketing teams</div>
        <div className="lp-logos-row" style={{ gridTemplateColumns: 'repeat(4, auto)', gap: '20px 28px', flexWrap: 'wrap' }}>
          {[
            'One agent, every platform',
            'Posts in your own voice',
            'You approve before it ships',
            'Cancel anytime',
          ].map((t) => (
            <span className="lp-logo" key={t} style={{ fontSize: 14 }}>
              <span className="glyph" aria-hidden="true">✓</span>
              <span>{t}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  </section>
);

const PreviewSection = () => (
  <section className="lp-section" id="workflow">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">The workspace</div>
          <h2>One briefing. Every channel. <em>Twelve minutes a day.</em></h2>
        </div>
        <p className="blurb">
          Open Sociafy in the morning. Read what your agent saw overnight,
          approve a few drafts, and close the tab. Everything posts itself.
        </p>
      </div>

      <div className="pp-anno-wrap">
        <div className="product-preview">
          <div className="pp-chrome">
            <div className="lights"><span /><span /><span /></div>
            <div className="url">app.sociafy.co/workspace/dashboard</div>
            <div style={{ width: 60 }} />
          </div>
          <div className="pp-body">
            <div className="pp-side">
              <div className="pp-brand">
                <div className="mark">S</div>
                <div>Sociafy<span style={{ color: 'var(--accent)' }}>.</span></div>
              </div>
              <div className="pp-section-label">Workspace</div>
              <div className="pp-item active"><span className="dot" /> Dashboard</div>
              <div className="pp-item"><span className="dot" /> Compose</div>
              <div className="pp-item"><span className="dot" /> Auto-pilot</div>
              <div className="pp-item"><span className="dot" /> Calendar</div>
              <div className="pp-section-label">Channels</div>
              <div className="pp-item"><PG k="x" /> X / Twitter</div>
              <div className="pp-item"><PG k="li" /> LinkedIn</div>
              <div className="pp-item"><PG k="ig" /> Instagram</div>
              <div className="pp-item"><PG k="tt" /> TikTok</div>
              <div className="pp-item"><PG k="yt" /> YouTube</div>
            </div>
            <div className="pp-main">
              <div>
                <div className="pp-h">Good morning</div>
                <div className="pp-sub">4 posts queued · your agent has 2 things for you</div>
              </div>

              <div className="pp-briefing">
                <div>
                  <div className="eb"><span className="pulse" /> Morning briefing · 6:42 AM</div>
                  <h4>Two trends in your niche are spiking. <em>I drafted 3 posts and a video script for you to review.</em></h4>
                  <p>A topic in your niche is gaining momentum — and your tone fits the conversation.</p>
                </div>
                <div className="pp-mini-meter">
                  <div className="row"><span>Posts queued</span><strong>4 / 5</strong></div>
                  <div className="bar"><div className="fill" style={{ width: '80%' }} /></div>
                  <div className="row"><span>Niche signal</span><strong>Strong</strong></div>
                  <div className="bar"><div className="fill" style={{ width: '88%' }} /></div>
                </div>
              </div>

              <div className="pp-stats">
                <div className="pp-stat"><div className="lbl">This week</div><div className="val">14</div><div className="delta">+3 vs last</div></div>
                <div className="pp-stat"><div className="lbl">Engagement</div><div className="val">8.2k</div><div className="delta">+18%</div></div>
                <div className="pp-stat"><div className="lbl">Reach 7d</div><div className="val">142k</div><div className="delta">+24%</div></div>
                <div className="pp-stat"><div className="lbl">Autopilot</div><div className="val">64%</div><div className="delta">+12 hrs saved</div></div>
              </div>

              <div className="pp-queue">
                <div className="qh"><span>Up next</span><span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', fontWeight: 400 }}>5 items</span></div>
                <div className="qrow">
                  <div className="qtime"><strong>14:30</strong>Today</div>
                  <div className="qtxt">The 3 metrics every solo founder should ignore (and the one you can&apos;t). A thread →</div>
                  <div className="qmeta"><PG k="x" /><PG k="li" /><span className="chip accent"><span className="dot" />92</span></div>
                </div>
                <div className="qrow">
                  <div className="qtime"><strong>18:00</strong>Today</div>
                  <div className="qtxt">Behind the scenes of our new studio setup. Spent 3 weekends repainting…</div>
                  <div className="qmeta"><PG k="ig" /><PG k="fb" /><span className="chip"><span className="dot" />agent</span></div>
                </div>
                <div className="qrow">
                  <div className="qtime"><strong>09:15</strong>Tomorrow</div>
                  <div className="qtxt">Hot take: most &quot;personal branding&quot; advice is just polished gatekeeping…</div>
                  <div className="qmeta"><PG k="li" /><PG k="x" /><span className="chip"><span className="dot" />draft</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="pp-anno" style={{ top: 60, left: -20 }}>
          <span className="num">1</span> AGENT BRIEFING
        </div>
        <div className="pp-anno" style={{ top: 240, right: -28 }}>
          <span className="num">2</span> SCORED AGAINST YOUR VOICE
        </div>
        <div className="pp-anno" style={{ bottom: 80, left: 168 }}>
          <span className="num">3</span> ONE QUEUE, ALL PLATFORMS
        </div>
      </div>

      <div className="feature-grid" style={{ marginTop: 64 }}>
        <div className="feature-cell">
          <div className="num">01 / Brief</div>
          <h3>Wakes up at 6 AM. So you don&apos;t have to.</h3>
          <p>Every morning the agent scans your niche, your competitors, and the conversation you usually join — and writes you a one-screen briefing.</p>
        </div>
        <div className="feature-cell">
          <div className="num">02 / Draft</div>
          <h3>Posts that actually sound like you.</h3>
          <p>Trained on the last 90 days of your writing. It mirrors your sentence rhythm, your punchlines, even the words you avoid.</p>
        </div>
        <div className="feature-cell">
          <div className="num">03 / Ship</div>
          <h3>Approve in batches. Or don&apos;t.</h3>
          <p>Set a confidence threshold and the agent auto-publishes anything above it. Anything below lands in your inbox with a tap-to-fix.</p>
        </div>
      </div>
    </div>
  </section>
);

const AgentShowcase = () => (
  <section className="lp-section dark" id="agent">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">Auto-pilot</div>
          <h2>An agent that actually <em>has taste</em>.</h2>
        </div>
        <p className="blurb">
          Most &quot;AI for social&quot; tools generate slop. Sociafy reads what&apos;s working in
          your niche this week, what&apos;s flopping for you, and what&apos;s drifting from
          your voice — then acts on it.
        </p>
      </div>

      <div className="agent-show">
        <div className="agent-show-mock">
          <div className="ahead">
            <span className="agent-mark">S</span>
            <span>Auto-pilot · today</span>
            <span className="live"><span className="dot" /> 4 actions</span>
          </div>

          <div className="amsg bot">
            <div className="who">S</div>
            <div>
              <div className="ts">06:42 · briefing</div>
              <div className="body">Held back a LinkedIn post — used <strong>&quot;game-changing&quot;</strong> twice. Rewrote it. Original is below if you want it.</div>
              <div className="amsg-actions">
                <button className="btn sm">See diff</button>
                <button className="btn sm primary">Approve rewrite</button>
              </div>
            </div>
          </div>

          <div className="amsg bot">
            <div className="who">S</div>
            <div>
              <div className="ts">07:11 · drafted</div>
              <div className="body">Three angles on your latest newsletter. Variant B fits your last 30 days best.</div>
              <div className="draft-card">
                <div className="dh">
                  <PG k="li" /> LinkedIn · variant B
                  <span className="score">92 / 100</span>
                </div>
                <div className="body">&quot;Compounding content is just compounding curiosity. Three small bets I made this quarter — only one paid off, but it paid for the other two…&quot;</div>
              </div>
              <div className="amsg-actions">
                <button className="btn sm">Edit</button>
                <button className="btn sm">Skip</button>
                <button className="btn sm primary">Schedule 12:30</button>
              </div>
            </div>
          </div>

          <div className="amsg user">
            <div className="who">J</div>
            <div>
              <div className="ts">08:02 · you</div>
              <div className="body">Push tomorrow&apos;s reel to 6:30 PM, that&apos;s where my engagement is.</div>
            </div>
          </div>

          <div className="amsg bot">
            <div className="who">S</div>
            <div>
              <div className="ts">08:02 · noted</div>
              <div className="body">Done. <strong>Reels at 18:30</strong> averaged +47% vs your 12:00 slot last 4 weeks. Want me to apply this rule going forward?</div>
            </div>
          </div>
        </div>

        <div className="agent-bullets">
          {[
            { gl: '01', h: 'Reads your niche, not the whole internet', p: 'Pulls signal from the 200–500 accounts that actually move your audience. No trending-tab noise, no celebrity gossip.' },
            { gl: '02', h: 'Holds drafts when they\'re off-brand', p: 'The voice profile is a hard filter. If a draft drifts — repeated phrases, off-tone, misaligned values — it gets held with a diff, not posted.' },
            { gl: '03', h: 'Learns from every approve / skip', p: 'The score isn\'t theatre. Every decision retrains the agent overnight, so next week\'s drafts hit faster.' },
            { gl: '04', h: 'Talks back like a co-worker', p: 'Ask it to push a slot, kill a topic, or write in a different register. It remembers, and it pushes back when you\'re wrong.' },
          ].map((b) => (
            <div className="agent-bullet" key={b.gl}>
              <div className="gl">{b.gl}</div>
              <div><h4>{b.h}</h4><p>{b.p}</p></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

const VoiceSection = () => (
  <section className="lp-section" id="voice">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">Voice training</div>
          <h2>Trained on you. <em>Not on Twitter.</em></h2>
        </div>
        <p className="blurb">
          Paste a few essays, point us at your last 90 days of posts, or
          read three short prompts out loud. The agent maps your voice along
          eleven axes and uses them as guardrails — not as a vibe.
        </p>
      </div>

      <div className="voice-train">
        <div className="voice-train-mock">
          <h5><span className="live-dot" /> Voice profile · trained on your recent posts</h5>
          {([
            ['Cadence', 'Punchy', 'Long', 78, '0.78'],
            ['Register', 'Casual', 'Formal', 32, '0.32'],
            ['Stance', 'Curious', 'Certain', 64, '0.64'],
            ['Humor', 'Dry', 'Playful', 41, '0.41'],
            ['Density', 'Sparse', 'Dense', 58, '0.58'],
            ['Stories', 'Abstract', 'Personal', 82, '0.82'],
          ] as [string, string, string, number, string][]).map(([lbl, lo, hi, val, num]) => (
            <div className="vt-row" key={lbl}>
              <span className="lbl">{lbl}</span>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'oklch(0.62 0 0)', marginBottom: 4 }}>
                  <span>{lo}</span><span>{hi}</span>
                </div>
                <div className="meter"><div className="fill" style={{ width: val + '%' }} /></div>
              </div>
              <span className="val">{num}</span>
            </div>
          ))}
          <div className="vt-foot">
            <span>Avoid list · 7 phrases</span>
            <strong>92% match · last 7d</strong>
          </div>
        </div>

        <div className="agent-bullets">
          {[
            { gl: 'A', h: 'Eleven measurable axes', p: 'Cadence, register, stance, density, humor — measurable enough to score, soft enough to evolve. Re-trains weekly from your approved posts.' },
            { gl: 'B', h: 'Phrase blocklist', p: "Add words you'd never say. The agent treats them as a hard veto — drafts containing them never hit the queue." },
            { gl: 'C', h: 'Multi-platform translator', p: 'One thought, four shapes. Long-form on LinkedIn, structured threads on X, short captions on IG, scripts for vertical video — same voice, native form.' },
            { gl: 'D', h: "Never trains on other users", p: "Your voice profile is yours. Sociafy doesn't pool it, share it, or use it to seed other accounts. Read the data sheet." },
          ].map((b) => (
            <div className="agent-bullet" key={b.gl}>
              <div className="gl">{b.gl}</div>
              <div><h4>{b.h}</h4><p>{b.p}</p></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

type Tier = 'starter' | 'pro' | 'business';

// ── Location-based pricing helpers ────────────────────────────────────────────
const CREDITS: Record<Tier, number> = { starter: 2000, pro: 6000, business: 25000 };
const TIER_OFF: Record<Tier, string> = { starter: '', pro: ' · 11% off Starter', business: ' · 20% off Starter' };

/** Guess the visitor's currency from their timezone (no network). India →
 *  INR, everyone else → USD. A manual toggle lets them override. */
const detectCurrency = (): Currency => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
  } catch { /* SSR / unsupported */ }
  return 'USD';
};

const tierPrice = (c: Currency, t: Tier): string => TIER_PRICING[c][t].priceMonthly;

/** Per-credit rate label, derived from the tier's minor-unit price ÷ credits. */
const perCreditLabel = (c: Currency, t: Tier): string => {
  const rate = TIER_PRICING[c][t].amountMinor / 100 / CREDITS[t];
  return c === 'INR' ? `₹${rate.toFixed(2)}` : `$${rate.toFixed(rate < 0.1 ? 4 : 3)}`;
};

const priceTag = (c: Currency, t: Tier): string =>
  `${CREDITS[t].toLocaleString()} credits / month · ${perCreditLabel(c, t)} per credit${TIER_OFF[t]}`;

const startCheckoutFromLanding = async (tier: Tier, setBusy: (t: Tier | null) => void) => {
  setBusy(tier);
  try {
    const r = await fetch('/api/billing/checkout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    if (r.status === 401) {
      // Not signed in — bounce through sign-up then back to billing for upgrade.
      window.location.href = `/sign-up?next=${encodeURIComponent(`/billing?tier=${tier}`)}`;
      return;
    }
    const data = await r.json().catch(() => ({} as { url?: string }));
    if (data?.url) {
      window.location.href = data.url;
    } else {
      // Billing isn't configured yet — send them to /billing so they see the
      // friendly "Stripe not configured" banner instead of a raw error.
      window.location.href = '/billing';
    }
  } finally {
    setBusy(null);
  }
};

const CurrencyToggle = ({ currency, setCurrency }: { currency: Currency; setCurrency: (c: Currency) => void }) => (
  <div className="ccy-toggle" style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 999, border: '1px solid var(--line, rgba(0,0,0,0.12))' }}>
    {(['INR', 'USD'] as Currency[]).map(c => (
      <button
        key={c}
        onClick={() => setCurrency(c)}
        aria-pressed={currency === c}
        style={{
          padding: '5px 12px',
          borderRadius: 999,
          border: 'none',
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          background: currency === c ? 'var(--ink, #0a0a0a)' : 'transparent',
          color: currency === c ? 'var(--bg, #fff)' : 'inherit',
        }}
      >
        {c === 'INR' ? '₹ India' : '$ Global'}
      </button>
    ))}
  </div>
);

const Pricing = ({ currency, setCurrency }: { currency: Currency; setCurrency: (c: Currency) => void }) => {
  const [busy, setBusy] = React.useState<Tier | null>(null);
  return (
  <section className="lp-section" id="pricing">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">Pricing</div>
          <h2>Every action is a <em>credit</em>. <em>Bigger plans, better rates.</em></h2>
        </div>
        <p className="blurb">
          Text post: 1 credit. AI image: 4 credits. 720p video reel: 180 credits.
          Top up anytime at {TOPUP_PRICING[currency].display}. No free trial — start when you&apos;re ready.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <CurrencyToggle currency={currency} setCurrency={setCurrency} />
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {currency === 'INR' ? 'Billed in ₹ via Razorpay · GST invoice' : 'Billed in $ · cards & wallets'}
        </span>
      </div>

      <div className="pricing">
        <div className="price-card">
          <div className="price-name">Starter</div>
          <div className="price-amt">{tierPrice(currency, 'starter')}<small>/ mo</small></div>
          <div className="price-tag">{priceTag(currency, 'starter')}</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> All 6 platforms</li>
            <li><span className="check">✓</span> Text, image &amp; 720p video gen</li>
            <li><span className="check">✓</span> ~11 reels OR 500 images / mo</li>
            <li><span className="check">✓</span> Manual posting + scheduling</li>
            <li><span className="check">✓</span> 1-month credit rollover</li>
            <li><span className="check" style={{ opacity: 0.4 }}>—</span> No autopilot</li>
          </ul>
          <div className="price-cta">
            <button className="btn" onClick={() => startCheckoutFromLanding('starter', setBusy)} disabled={busy !== null}>
              {busy === 'starter' ? 'Redirecting…' : 'Start now'}
            </button>
          </div>
        </div>

        <div className="price-card featured">
          <div className="price-name">Pro</div>
          <div className="price-amt">{tierPrice(currency, 'pro')}<small>/ mo</small></div>
          <div className="price-tag">{priceTag(currency, 'pro')}</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> Everything in Starter</li>
            <li><span className="check">✓</span> <strong>Autopilot enabled</strong> — <span style={{ whiteSpace: 'nowrap' }}>trend &rarr; draft &rarr; schedule</span></li>
            <li><span className="check">✓</span> Web research on captions</li>
            <li><span className="check">✓</span> ~33 reels OR daily image + research</li>
            <li><span className="check">✓</span> Per-platform &amp; per-content quotas</li>
            <li><span className="check">✓</span> Priority email support</li>
          </ul>
          <div className="price-cta">
            <button className="btn primary" onClick={() => startCheckoutFromLanding('pro', setBusy)} disabled={busy !== null}>
              {busy === 'pro' ? 'Redirecting…' : 'Start now'}
            </button>
          </div>
        </div>

        <div className="price-card">
          <div className="price-name">Business</div>
          <div className="price-amt">{tierPrice(currency, 'business')}<small>/ mo</small></div>
          <div className="price-tag">{priceTag(currency, 'business')}</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> Everything in Pro</li>
            <li><span className="check">✓</span> <strong>30 daily 720p reels + 5 × 1080p hero clips / mo</strong></li>
            <li><span className="check">✓</span> Autopilot with media generation</li>
            <li><span className="check">✓</span> 2-month credit rollover</li>
            <li><span className="check">✓</span> Priority support + onboarding call</li>
            <li><span className="check">✓</span> Best per-credit value of any tier</li>
          </ul>
          <div className="price-cta">
            <button className="btn" onClick={() => startCheckoutFromLanding('business', setBusy)} disabled={busy !== null}>
              {busy === 'business' ? 'Redirecting…' : 'Start now'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 16, fontSize: 11.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
        Every plan covers all six platforms — X · LinkedIn · Instagram · Facebook · TikTok · YouTube
      </div>

      <div style={{ textAlign: 'center', marginTop: 32, fontSize: 12.5, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
        Need more? Top up at $15 / 1,000 credits · Annual plans save 2 months · Custom Enterprise tier on request
      </div>
    </div>
  </section>
  );
};

const FAQ_ITEMS = [
  ['How does pricing actually work?', 'Every plan is credit-based: Starter is $30/mo (2,000 credits), Pro is $80/mo (6,000 credits), and Business is $299/mo (25,000 credits). Each action costs credits — a text post is 1 credit, an AI image is 4, a 720p video reel is 180. There is no free trial; you can top up anytime at $15 per 1,000 credits and cancel in one click.'],
  ['Does the agent post without my approval?', 'Only if you tell it to. Autopilot is a Pro and Business feature, and it is off by default. When you turn it on you set a confidence threshold (e.g. ≥ 90/100) and a quiet-hours window — anything below the bar lands in your inbox for review.'],
  ['What does “voice training” actually use?', 'Whatever you give it: pasted essays, a public profile URL, your last 30–90 days of posts, or three short voice memos. Nothing leaves your workspace, and we never use your writing to train other accounts.'],
  ['Which platforms are supported?', 'X, LinkedIn, Instagram, Facebook, TikTok, and YouTube — on every plan. Each platform gets a native draft, not a copy-paste with #hashtags slapped on.'],
  ['What happens to my credits and posts if I cancel?', 'Cancellation takes effect at the end of your current billing cycle, so anything already scheduled keeps publishing until then and your remaining cycle credits stay usable. Unused monthly credits roll over for one month (two months on Business). See the Refund & Cancellation policy for details.'],
] as const;

const FAQSection = ({ currency }: { currency: Currency }) => {
  const p = TIER_PRICING[currency];
  const pricingAnswer = `Every plan is credit-based: Starter is ${p.starter.priceMonthly}/mo (2,000 credits), Pro is ${p.pro.priceMonthly}/mo (6,000 credits), and Business is ${p.business.priceMonthly}/mo (25,000 credits). Each action costs credits — a text post is 1 credit, an AI image is 4, a 720p video reel is 180. There is no free trial; you can top up anytime at ${TOPUP_PRICING[currency].display} and cancel in one click.`;
  const items = FAQ_ITEMS.map((it, i) => (i === 0 ? ([it[0], pricingAnswer] as const) : it));
  return (
  <section className="lp-section" id="faq">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">FAQ</div>
          <h2>Five things <em>founders ask first</em>.</h2>
        </div>
        <p className="blurb">More in the docs, or ping us — a real person replies in under an hour during EU/US hours.</p>
      </div>
      <div className="faq">
        {items.map(([q, a], i) => (
          <div className="faq-item" key={i}>
            <div className="faq-num">/ 0{i + 1}</div>
            <div className="faq-q">{q}</div>
            <div className="faq-a">{a}</div>
          </div>
        ))}
      </div>
    </div>
  </section>
  );
};

const FinalCTA = () => (
  <section className="lp-section" style={{ paddingTop: 96, paddingBottom: 0, borderTop: 0 }}>
    <div className="lp">
      <div className="final-cta">
        <div>
          <h2>Stop posting on willpower.<br /><em>Start shipping on auto-pilot.</em></h2>
          <p>Connect two accounts in under three minutes. The agent will have your first morning briefing ready by tomorrow at 6 AM.</p>
          <div className="final-cta-actions">
            <Link className="btn primary" href="/sign-up"><SparkleIcon /> Start now</Link>
            <a className="btn" href="#agent">Build agents</a>
            <a className="btn" href="#pricing"><LockIcon /> See pricing</a>
          </div>
        </div>
        <div className="final-cta-side">
          <div className="lbl">What you get on day one</div>
          <div className="row"><span>Connected channels</span><strong>up to 6</strong></div>
          <div className="row"><span>Voice profile training</span><strong>~ 4 min</strong></div>
          <div className="row"><span>First briefing arrives</span><strong>06:00 local</strong></div>
          <div className="row"><span>Time to first post</span><strong className="accent">~ 12 min</strong></div>
          <div className="row"><span>Cancel anytime</span><strong>1 click</strong></div>
        </div>
      </div>
    </div>
  </section>
);

const Footer = () => (
  <footer className="lp-foot">
    <div className="lp">
      <div className="lp-foot-grid">
        <div className="lp-foot-brand">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">S</div>
            <div className="brand-name">Sociafy<span className="dot">.</span></div>
          </div>
          <p>The AI social agent for founders who&apos;d rather be building.</p>
          <div className="lp-foot-socials" style={{ marginTop: 16 }}>
            <PG k="x" /><PG k="li" /><PG k="ig" /><PG k="yt" />
          </div>
        </div>
        <div className="lp-foot-col">
          <h6>Product</h6>
          <ul>
            <li><a href="#agent">Agent</a></li>
            <li><a href="#workflow">Workflow</a></li>
            <li><a href="#voice">Voice training</a></li>
            <li><a href="#pricing">Pricing</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Company</h6>
          <ul>
            <li><a href="mailto:hello@sociafy.app">Contact</a></li>
            <li><a href="mailto:careers@sociafy.app">Careers</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Resources</h6>
          <ul>
            <li><a href="mailto:support@sociafy.app">Support</a></li>
            <li><a href="#voice">Voice guide</a></li>
            <li><a href="#pricing">Pricing</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Legal</h6>
          <ul>
            <li><a href="/legal/privacy">Privacy</a></li>
            <li><a href="/legal/terms">Terms</a></li>
            <li><a href="/legal/refund">Refund &amp; Cancellation</a></li>
          </ul>
        </div>
      </div>
      <div className="lp-foot-bottom" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <span>Sociafy is a product of <strong>GNIX SEMICONDUCTORS PRIVATE LIMITED</strong>.</span>
        <span>2TF, Satyam Complex 2, Sector Alpha II, Greater Noida, Uttar Pradesh 201310, India</span>
        <span>© 2026 GNIX SEMICONDUCTORS PRIVATE LIMITED · Made for founders.</span>
      </div>
    </div>
  </footer>
);

export default function LandingPage() {
  const [currency, setCurrency] = React.useState<Currency>('USD');
  // Default to the visitor's likely currency (India → INR) after mount.
  React.useEffect(() => { setCurrency(detectCurrency()); }, []);
  return (
    <>
      <SkipLink />
      <LPNav />
      <main id="main">
        <Hero currency={currency} />
        <PreviewSection />
        <AgentShowcase />
        <VoiceSection />
        <Pricing currency={currency} setCurrency={setCurrency} />
        <FAQSection currency={currency} />
        <FinalCTA />
      </main>
      <Footer />
    </>
  );
}
