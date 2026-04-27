'use client';

import React from 'react';
import Link from 'next/link';

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

const PlayIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const LockIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
);

const PG = ({ k }: { k: string }) => (
  <span className={`pglyph ${k}`}>
    {({ ig: 'I', fb: 'f', x: 'X', li: 'in', tt: 'T', yt: 'Y', th: '@' } as Record<string, string>)[k]}
  </span>
);

const LPNav = () => (
  <div className="lp-nav-wrap">
    <div className="lp lp-nav">
      <Link href="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand-mark">S</div>
        <div className="brand-name">Sociafy<span className="dot">.</span></div>
      </Link>
      <nav className="lp-nav-links">
        <a href="#agent">Agent</a>
        <a href="#workflow">Workflow</a>
        <a href="#voice">Voice</a>
        <a href="#pricing">Pricing</a>
      </nav>
      <div className="lp-nav-spacer" />
      <div className="lp-nav-actions">
        <span className="lp-nav-status"><span className="dot" /> 1,284 founders posting today</span>
        <a className="btn" href="#login">Log in</a>
        <Link className="btn primary" href="/dashboard">
          Start free <ArrowIcon />
        </Link>
      </div>
    </div>
  </div>
);

const Hero = () => (
  <section className="hero">
    <div className="lp">
      <div className="hero-grid">
        <div>
          <span className="hero-eyebrow">
            <span className="pill">NEW</span>
            Voice-trained agent · v2.4
            <span className="arrow">→</span>
          </span>
          <h1>
            Your social presence,<br />
            <em>without</em> the second <span className="accent">full-time job</span>.
          </h1>
          <p className="hero-lede">
            Sociafy is an AI agent that learns your voice, watches your niche, and
            ships posts on every platform — while you keep building. You stay in
            the loop. The grind doesn&apos;t.
          </p>
          <div className="hero-cta">
            <Link className="btn btn-lg primary" href="/dashboard">
              <SparkleIcon /> Connect accounts <span className="kbd">⌘ ↵</span>
            </Link>
            <a className="btn btn-lg" href="#workflow">
              <PlayIcon /> Watch 90s demo
            </a>
          </div>
          <div className="hero-meta">
            <span className="dotted">14-day free trial</span>
            <span className="dotted">No credit card</span>
            <span className="dotted">SOC&nbsp;2 Type II</span>
          </div>
        </div>

        <aside className="hero-side">
          <div className="hero-side-head">
            <span className="agent-mark">S</span>
            <span>Agent feed · live</span>
            <span className="live"><span className="pulse" /> watching</span>
          </div>

          <div className="feed-row">
            <span className="ts">2 min ago · trend</span>
            <div className="body">
              <strong>Spotted a +312% spike</strong> in <em>&quot;agentic content&quot;</em>.
              Your last 3 posts on this topic averaged 2.1k impressions.
            </div>
          </div>
          <div className="feed-row">
            <span className="ts">14 min ago · drafts</span>
            <div className="body">
              Drafted <strong>3 angles</strong> from your newsletter #47.
              Variant B scored 92/100 against your voice.
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
            <Link className="btn accent" href="/dashboard">Review drafts</Link>
            <Link className="btn" href="/dashboard">See full briefing</Link>
          </div>
        </aside>
      </div>
    </div>

    <div className="lp">
      <div className="lp-logos">
        <div className="lp-logos-label">Trusted by 4,200+ solo founders, indie studios &amp; small marketing teams</div>
        <div className="lp-logos-row">
          {[['LD', 'Linden'], ['HC', 'Halcyon'], ['NV', 'Northvane'], ['QO', 'Quoram'], ['FL', 'Flint & Co'], ['SR', 'Strider']].map(([g, n]) => (
            <span className="lp-logo" key={n}>
              <span className="glyph">{g}</span>
              <span>{n}</span>
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
                <div className="pp-h">Good morning, Jordan</div>
                <div className="pp-sub">Apr 27 · 4 posts queued · agent has 2 things for you</div>
              </div>

              <div className="pp-briefing">
                <div>
                  <div className="eb"><span className="pulse" /> Morning briefing · 6:42 AM</div>
                  <h4>Two trends in your niche are spiking. <em>I drafted 3 posts and a video script for you to review.</em></h4>
                  <p>Agentic workflows are up 312% since yesterday — your tone fits the conversation.</p>
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
              <div className="body">Three angles on your newsletter #47. Variant B fits your last 30 days best.</div>
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
          <h5><span className="live-dot" /> Voice profile · Jordan Reyes · trained on 47 posts</h5>
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

const Pricing = () => (
  <section className="lp-section" id="pricing">
    <div className="lp">
      <div className="lp-section-head">
        <div>
          <div className="lp-section-eyebrow">Pricing</div>
          <h2>Pay for what posts. <em>Not for seats.</em></h2>
        </div>
        <p className="blurb">
          Start free. Upgrade when the agent saves you more time than it costs —
          we&apos;ll tell you the day it does.
        </p>
      </div>

      <div className="pricing">
        <div className="price-card">
          <div className="price-name">Solo</div>
          <div className="price-amt">$0<small>/ forever</small></div>
          <div className="price-tag">For testing the waters and your first 30 posts.</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> 2 connected accounts</li>
            <li><span className="check">✓</span> 30 AI drafts / month</li>
            <li><span className="check">✓</span> Manual approve only</li>
            <li><span className="check">✓</span> 7-day briefing history</li>
            <li><span className="check">✓</span> Community support</li>
          </ul>
          <div className="price-cta"><Link className="btn" href="/dashboard">Start free</Link></div>
        </div>

        <div className="price-card featured">
          <div className="price-name">Founder</div>
          <div className="price-amt">$29<small>/ mo</small></div>
          <div className="price-tag">Auto-pilot, all platforms, voice training. The default.</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> Unlimited accounts &amp; platforms</li>
            <li><span className="check">✓</span> Unlimited AI drafts</li>
            <li><span className="check">✓</span> Auto-pilot with confidence threshold</li>
            <li><span className="check">✓</span> Voice training on 90 days of writing</li>
            <li><span className="check">✓</span> Trend &amp; competitor monitoring</li>
            <li><span className="check">✓</span> 12-month analytics &amp; export</li>
          </ul>
          <div className="price-cta"><Link className="btn primary" href="/dashboard">Start 14-day trial</Link></div>
        </div>

        <div className="price-card">
          <div className="price-name">Studio</div>
          <div className="price-amt">$89<small>/ mo</small></div>
          <div className="price-tag">For 2-person teams and founders with a ghostwriter.</div>
          <div className="price-divider" />
          <ul className="price-list">
            <li><span className="check">✓</span> Everything in Founder</li>
            <li><span className="check">✓</span> 3 voice profiles</li>
            <li><span className="check">✓</span> Approval routing &amp; roles</li>
            <li><span className="check">✓</span> Brand kit &amp; asset library</li>
            <li><span className="check">✓</span> SOC&nbsp;2 + SSO</li>
            <li><span className="check">✓</span> Priority human support</li>
          </ul>
          <div className="price-cta"><Link className="btn" href="/dashboard">Talk to us</Link></div>
        </div>
      </div>
    </div>
  </section>
);

const FAQ_ITEMS = [
  ['Does the agent post without my approval?', 'Only if you tell it to. Auto-publish is off by default. When you turn it on, you set a confidence threshold (e.g. ≥ 90/100) and a quiet-hours window — anything below the bar lands in your inbox.'],
  ['What does “voice training” actually use?', 'Whatever you give it: pasted essays, a public profile URL, your last 30–90 days of posts, or three short voice memos. Nothing leaves your workspace, and we never use your writing to train other accounts.'],
  ['Which platforms are supported?', 'Today: X, LinkedIn, Instagram, Facebook, TikTok, YouTube Shorts and Threads. Each platform gets a native draft — not a copy-paste with #hashtags slapped on.'],
  ['What happens to scheduled posts if I cancel?', 'Anything already scheduled keeps publishing through your billing period. You can export every draft, scheduled post, and analytics record as a single CSV from settings.'],
  ['Is there a way to keep a human in the loop on Studio plans?', 'Yes — approval routing lets a teammate (or your ghostwriter) sign off before anything posts, and every action is logged with a diff.'],
] as const;

const FAQSection = () => (
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
        {FAQ_ITEMS.map(([q, a], i) => (
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

const FinalCTA = () => (
  <section className="lp-section" style={{ paddingTop: 96, paddingBottom: 0, borderTop: 0 }}>
    <div className="lp">
      <div className="final-cta">
        <div>
          <h2>Stop posting on willpower.<br /><em>Start shipping on auto-pilot.</em></h2>
          <p>Connect two accounts in under three minutes. The agent will have your first morning briefing ready by tomorrow at 6 AM.</p>
          <div className="final-cta-actions">
            <Link className="btn primary" href="/dashboard"><SparkleIcon /> Start free trial</Link>
            <a className="btn" href="#workflow">Watch the 90s tour</a>
            <a className="btn" href="#"><LockIcon /> Read security note</a>
          </div>
        </div>
        <div className="final-cta-side">
          <div className="lbl">What you get on day one</div>
          <div className="row"><span>Connected channels</span><strong>up to 7</strong></div>
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
            <div className="brand-mark">S</div>
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
            <li><a href="#">About</a></li>
            <li><a href="#">Manifesto</a></li>
            <li><a href="#">Blog</a></li>
            <li><a href="#">Careers</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Resources</h6>
          <ul>
            <li><a href="#">Docs</a></li>
            <li><a href="#">Voice guide</a></li>
            <li><a href="#">API</a></li>
            <li><a href="#">Status</a></li>
          </ul>
        </div>
        <div className="lp-foot-col">
          <h6>Legal</h6>
          <ul>
            <li><a href="#">Security</a></li>
            <li><a href="#">Privacy</a></li>
            <li><a href="#">Terms</a></li>
            <li><a href="#">DPA</a></li>
          </ul>
        </div>
      </div>
      <div className="lp-foot-bottom">
        <span>© 2026 Sociafy Labs · Made for founders, in Lisbon &amp; Brooklyn</span>
        <span>v2.4.1 · all systems normal</span>
      </div>
    </div>
  </footer>
);

export default function LandingPage() {
  return (
    <>
      <LPNav />
      <Hero />
      <PreviewSection />
      <AgentShowcase />
      <VoiceSection />
      <Pricing />
      <FAQSection />
      <FinalCTA />
      <Footer />
    </>
  );
}
