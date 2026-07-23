# 📊 Trend Analysis — Multi-Platform Trend Intelligence

> **Branch:** `feature/trend-analysis`
> Apify-backed, AI-powered trend radar that watches Instagram, TikTok, and YouTube so you can ride trends before they peak.

---

## What It Does

Sociafy's Trend Analysis module scrapes live social data across three platforms, scores every hashtag and audio track through a lifecycle forecasting engine, and surfaces **actionable intelligence** — not just charts.

### Core Capabilities

| Feature | Description |
|---|---|
| **Hashtag Trend Tracking** | Track your niche hashtags across Instagram. See engagement velocity, top posts, trending audio, and week-over-week momentum comparisons. |
| **Lifecycle Forecasting** | A least-squares parabolic fit (`E = At² + Bt + C`) classifies every entity as **Emerging → Rising → Peaking → Declining** with projected peak times and confidence scores. |
| **Cross-Platform Radar** | TikTok and YouTube Shorts are scraped on the same schedule. Trends that exist on those platforms but *not yet on your Instagram* get flagged as **high-alert opportunities** with "act now" windows. |
| **AI Strategy Briefs** | Groq LLM generates concrete content ideas per trend (not generic "post soon" advice — actual reel/carousel angles in ≤18 words) and a full brand strategy blending your niche, competitor landscape, and trend signals. |
| **Notification Alerts** | High-alert cross-platform opportunities push to the activity bell so they show up without opening the Trends tab. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Dashboard UI                          │
│  components/trends/trends-dashboard.tsx (⌘6, chart)     │
│  Sparklines · Radar · Strategy · WoW comparisons        │
└──────────────────────┬──────────────────────────────────┘
                       │ fetch
┌──────────────────────▼──────────────────────────────────┐
│              API Routes — /api/trend-intel/*             │
│  GET  /                 → aggregated trend data + AI     │
│  GET  /radar            → watchlist forecasts            │
│  GET  /cross-platform   → TikTok/YT opportunities       │
│  POST /refresh          → manual re-scrape trigger       │
│  GET  /snapshots        → snapshot history               │
│  GET|PUT /settings      → tracked hashtags, niche, etc.  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  Intelligence Engine                     │
│  lib/intel/forecast.ts     — parabolic lifecycle fit     │
│  lib/intel/cross-platform  — gap detection across IG/TT  │
│  lib/intel/strategist.ts   — LLM verdicts + brand plan   │
│  lib/intel/general-trends  — broad-market buckets        │
│  lib/intel/llm.ts          — Groq/OpenRouter client      │
│  lib/taccv/trend-analysis  — engagement scoring          │
│  lib/taccv/ai-summary      — trend narrative generation  │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   Apify Scrapers                         │
│  lib/scrapers/apify.ts      — IG hashtag scraper         │
│  lib/scrapers/tiktok.ts     — TikTok hashtag scraper     │
│  lib/scrapers/youtube.ts    — YouTube Shorts scraper     │
│  lib/scrapers/apify-client  — shared run-sync client     │
│  lib/scrapers/dummy.ts      — offline fallback           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                    Supabase / Drizzle                     │
│  trend_snapshots · trend_posts · trend_settings          │
│  ai_cache · api_usage · activity_log                     │
└─────────────────────────────────────────────────────────┘
```

---

## Apify Actors Used

| Actor | Platform | Purpose |
|---|---|---|
| `apify~instagram-hashtag-scraper` | Instagram | Top posts per hashtag (likes, comments, views, audio, captions) |
| `clockworks~tiktok-scraper` | TikTok | Hashtag posts for cross-platform gap detection |
| `streamers~youtube-scraper` | YouTube | Shorts search results for cross-platform radar |

---

## Database Tables (New)

All tables are created via `drizzle/0010_trend_competitor_intel.sql` — run it in the **Supabase SQL Editor**.

| Table | Purpose |
|---|---|
| `trend_snapshots` | Per-user, per-platform scrape snapshots with timestamps |
| `trend_posts` | Individual post data (likes, comments, views, audio, hashtags) linked to snapshots |
| `trend_settings` | User preferences: tracked hashtags, niche label, self-handle, company description |
| `ai_cache` | MD5-keyed LLM response cache to avoid redundant Groq calls |
| `api_usage` | Metered usage tracking (analysis calls, scrapes, etc.) |

---

## API Routes

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/trend-intel` | User | Full trend payload: engagement data, WoW comparison, AI summary, strategy, audio links |
| `GET` | `/api/trend-intel/radar` | User | Watchlist forecasts with lifecycle stages, sparklines, and LLM verdicts |
| `GET` | `/api/trend-intel/cross-platform` | User | TikTok/YouTube opportunities not yet on Instagram, with high-alert flags |
| `POST` | `/api/trend-intel/refresh` | User | Manual re-scrape (all platforms) |
| `GET` | `/api/trend-intel/snapshots` | User | Snapshot history for the current user |
| `GET/PUT` | `/api/trend-intel/settings` | User | Read/update tracked hashtags, niche, company description |
| `GET/POST` | `/api/cron/refresh-trends` | Cron | Scheduled refresh for all users + high-alert logging |

---

## UI Tab

**Trends** (⌘6, chart icon) — a single-page dashboard with:

- **Niche hashtag performance** — engagement, top posts, trending audio with direct Instagram links
- **Momentum table** — week-over-week comparison of your tracked hashtags
- **Lifecycle radar** — every entity classified as Emerging/Rising/Peaking/Declining with sparkline charts
- **Cross-platform alerts** — TikTok & YouTube trends not yet on Instagram, with "act now" windows
- **AI strategy panel** — content ideas, do/don't lists, brand positioning recommendations
- **Settings panel** — configure tracked hashtags, niche, and company context for better AI output

---

## Environment Variables

```env
# Required for live scraping
APIFY_TOKEN=apify_api_xxx

# Required for AI features (already configured)
GROQ_API_KEY=gsk_xxx

# Optional
APIFY_TREND_LIMIT=30          # posts per hashtag per scrape (default: 30)
GROQ_TREND_MODEL=llama-3.3-70b-versatile  # override LLM model
OPENROUTER_API_KEY=sk-or-xxx  # fallback if GROQ_API_KEY not set
```

---

## Setup

1. **Provision tables** — Run `drizzle/0010_trend_competitor_intel.sql` in the Supabase SQL Editor
2. **Add env vars** — Set `APIFY_TOKEN` in `.env.local`
3. **First scrape** — Open the Trends tab → Settings → add tracked hashtags → click Refresh
4. **Cron** — Set up `GET /api/cron/refresh-trends` to run every 12–48 hours (Vercel cron or external)

---

## How the Forecast Engine Works

The forecast engine (`lib/intel/forecast.ts`) fits a **least-squares parabola** to each entity's engagement time series:

```
Engagement = A·t² + B·t + C
```

- **A < 0** → a peak exists at `t* = -B/(2A)` — we know when it'll crest
- **Velocity** → normalized slope as %/day
- **Stages** → Emerging (velocity > 0, pre-peak) → Rising (velocity > 20%/day) → Peaking (near peak ± 6h) → Declining (past peak)
- **Confidence** → R² of the fit, weighted by number of data points

The cross-platform module then compares TikTok/YouTube forecasts against what's already on your Instagram to find **gaps** — trends peaking on other platforms that you haven't posted about yet.

---

## File Inventory

<details>
<summary>44 files changed from main (click to expand)</summary>

**API Routes (7)**
- `app/api/trend-intel/route.ts` — main GET endpoint
- `app/api/trend-intel/radar/route.ts` — watchlist forecasts
- `app/api/trend-intel/cross-platform/route.ts` — cross-platform radar
- `app/api/trend-intel/refresh/route.ts` — manual scrape trigger
- `app/api/trend-intel/settings/route.ts` — user settings CRUD
- `app/api/trend-intel/snapshots/route.ts` — snapshot history
- `app/api/cron/refresh-trends/route.ts` — scheduled refresh cron

**Intelligence (11)**
- `lib/intel/forecast.ts` — parabolic lifecycle forecasting
- `lib/intel/cross-platform.ts` — gap detection logic
- `lib/intel/cross-platform-radar.ts` — DB orchestration for cross-platform
- `lib/intel/strategist.ts` — LLM verdicts + brand strategy
- `lib/intel/general-trends.ts` — broad-market trend buckets
- `lib/intel/llm.ts` — Groq/OpenRouter shared client + cache
- `lib/intel/competitor-intel.ts` — competitor data rollups (shared)
- `lib/intel/discover-competitors.ts` — AI competitor discovery (shared)
- `lib/intel/discover-linkedin.ts` — LinkedIn discovery (shared)
- `lib/intel/refresh-competitors.ts` — competitor refresh (shared)
- `lib/intel/refresh-linkedin.ts` — LinkedIn refresh (shared)
- `lib/intel/linkedin-intel.ts` — LinkedIn analysis (shared)
- `lib/intel/targeting.ts` — audience targeting (shared)
- `lib/intel/creator-audit.ts` — creator analysis (shared)

**Scrapers (8)**
- `lib/scrapers/apify-client.ts` — shared Apify run-sync client
- `lib/scrapers/apify.ts` — Instagram hashtag scraper
- `lib/scrapers/tiktok.ts` — TikTok scraper
- `lib/scrapers/youtube.ts` — YouTube Shorts scraper
- `lib/scrapers/competitors.ts` — Instagram profile scraper (shared)
- `lib/scrapers/linkedin.ts` — LinkedIn company scraper (shared)
- `lib/scrapers/stories.ts` — Instagram stories scraper (shared)
- `lib/scrapers/dummy.ts` — offline fallback
- `lib/scrapers/registry.ts` — scraper registration
- `lib/scrapers/types.ts` — shared scraper types

**Analysis (3)**
- `lib/taccv/trend-analysis.ts` — engagement scoring + data building
- `lib/taccv/ai-summary.ts` — AI trend narrative
- `lib/taccv/refresh.ts` — scrape-to-DB refresh orchestration
- `lib/taccv/creator-analysis.ts` — creator analysis (shared)

**Utilities (3)**
- `lib/text/hashtag.ts` — hashtag normalization
- `lib/text/truncate.ts` — text truncation
- `lib/usage.ts` — metered API usage tracking

**UI (3)**
- `components/trends/trends-dashboard.tsx` — full trend dashboard
- `components/spark.tsx` — sparkline chart component
- `components/shell.tsx` — navigation tab addition

**Database (2)**
- `lib/db/schema.ts` — +13 Drizzle table definitions
- `drizzle/0010_trend_competitor_intel.sql` — migration SQL

**Dashboard (1)**
- `app/dashboard/page.tsx` — tab routing update

</details>
