# 🎯 Competitor Analysis — Instagram & LinkedIn Intelligence

> **Branch:** `feature/competitor-analysis`
> Track up to 10 Instagram competitors and unlimited LinkedIn companies. Per-post scraping, daily rollups, AI-powered strategy, and landscape analysis.

---

## What It Does

Sociafy's Competitor Analysis module lets you monitor your competitive landscape across Instagram and LinkedIn — not just follower counts, but deep per-post intelligence: content themes, posting cadence, format mix, best times, trending audio, and AI-generated "do this / don't do this" strategy recommendations.

### Core Capabilities

| Feature | Description |
|---|---|
| **Instagram Competitor Tracking** | Track ≤10 competitor handles. Each scrape pulls their latest posts with likes, comments, views, hashtags, audio, and auto-derived content themes. |
| **Per-Competitor Insights** | Posts-per-week, format mix (reel/carousel/image), best posting hours (IST), best days, hashtag strategy, top audio tracks, engagement trends, and follower growth. |
| **Landscape View** | Cross-competitor aggregate: average cadence, common themes, common hashtags, busiest hours, white-space hours (when nobody's posting), and AI strategy. |
| **AI Competitor Discovery** | Describe your business → AI mines your niche hashtag data to find real competitors in your space, scores them for relevance, and auto-adds the top candidates. |
| **LinkedIn Company Tracking** | Add companies by URL/slug. Scrapes firmographics (industry, HQ, founding year, specialities), follower counts, employee headcount, and daily growth series. |
| **LinkedIn Landscape** | Cross-company aggregate: total/avg followers, avg headcount, top growth movers, industry breakdown. |
| **LinkedIn AI Discovery** | Describe your business → AI suggests competitor LinkedIn pages to track. |
| **Stories Tracking** | Scrapes Instagram story counts per competitor for daily rollups (stories/day metric). |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Dashboard UI                             │
│  components/competitors/competitors-dashboard.tsx (⌘6, target)   │
│  components/competitors/linkedin-dashboard.tsx   (⌘7, link)      │
│  Cards · Landscape · Insights · Heatmaps · Strategy panels       │
└──────────────────────┬──────────────────────────────────────────┘
                       │ fetch
┌──────────────────────▼──────────────────────────────────────────┐
│                    API Routes                                    │
│  /api/competitors/*    — Instagram competitor CRUD + insights     │
│  /api/linkedin/*       — LinkedIn company CRUD + landscape        │
│  /api/cron/refresh-*   — scheduled scrape crons                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                 Intelligence Engine                               │
│  lib/intel/competitor-intel.ts   — per-competitor rollups (pure)   │
│  lib/intel/discover-competitors  — AI competitor discovery         │
│  lib/intel/discover-linkedin     — LinkedIn AI discovery           │
│  lib/intel/refresh-competitors   — scrape → DB orchestration       │
│  lib/intel/refresh-linkedin      — LinkedIn scrape → DB            │
│  lib/intel/linkedin-intel.ts     — LinkedIn landscape (pure)       │
│  lib/intel/strategist.ts         — LLM do/don't lists + plans     │
│  lib/intel/llm.ts                — Groq/OpenRouter shared client   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                    Apify Scrapers                                 │
│  lib/scrapers/competitors.ts   — IG profile + posts scraper       │
│  lib/scrapers/stories.ts       — IG story count scraper           │
│  lib/scrapers/linkedin.ts      — LinkedIn company detail scraper  │
│  lib/scrapers/apify-client.ts  — shared run-sync client           │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                   Supabase / Drizzle                              │
│  competitors · competitor_posts · competitor_metrics              │
│  linkedin_companies · linkedin_metrics                            │
│  ai_cache · api_usage                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Apify Actors Used

| Actor | Platform | Purpose |
|---|---|---|
| `apify~instagram-scraper` | Instagram | Profile stats + latest posts per competitor handle |
| `apify~instagram-story-scraper` | Instagram | Story count per competitor for daily stories/day metric |
| `apimaestro~linkedin-company-detail` | LinkedIn | Firmographics, follower count, employee headcount |
| `apimaestro~linkedin-companies-search-scraper` | LinkedIn | Search for company pages by keyword (AI discovery) |

---

## Database Tables (New)

All tables are created via `drizzle/0010_trend_competitor_intel.sql` — run it in the **Supabase SQL Editor**.

| Table | Purpose |
|---|---|
| `competitors` | Tracked competitor handles with metadata, active/inactive status |
| `competitor_posts` | Per-post data: likes, comments, views, shares, hashtags, theme, audio, type |
| `competitor_metrics` | Daily rollups: follower count, posts count, stories count, avg engagement rate |
| `linkedin_companies` | Tracked LinkedIn companies with full firmographics |
| `linkedin_metrics` | Daily follower + employee headcount snapshots |
| `ai_cache` | MD5-keyed LLM response cache |
| `api_usage` | Metered usage tracking |

---

## API Routes

### Instagram Competitors (`/api/competitors`)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/competitors` | List all tracked competitors with latest metrics |
| `POST` | `/api/competitors` | Add a competitor by handle (max 10 active) |
| `DELETE` | `/api/competitors/[id]` | Remove a competitor |
| `PATCH` | `/api/competitors/[id]` | Toggle active status or update notes |
| `GET` | `/api/competitors/[id]/insights` | Deep per-competitor intelligence (format mix, best times, themes, strategy) |
| `GET` | `/api/competitors/landscape` | Cross-competitor landscape aggregate + AI strategy |
| `POST` | `/api/competitors/discover` | AI-powered competitor discovery from niche hashtag data |
| `POST` | `/api/competitors/refresh` | Manual re-scrape of all active competitors |
| `GET/POST` | `/api/cron/refresh-competitors` | Scheduled competitor refresh cron |

### LinkedIn Companies (`/api/linkedin`)

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/linkedin` | List all tracked companies + landscape aggregate |
| `POST` | `/api/linkedin` | Add a company by LinkedIn URL or vanity slug |
| `DELETE` | `/api/linkedin/[id]` | Remove a company |
| `POST` | `/api/linkedin/discover` | AI-powered LinkedIn company discovery |
| `POST` | `/api/linkedin/refresh` | Manual re-scrape of all tracked companies |
| `GET/POST` | `/api/cron/refresh-linkedin` | Scheduled LinkedIn refresh cron |

---

## UI Tabs

### Competitors (⌘6, target icon)

- **Competitor cards** — follower count, engagement rate, sparkline growth chart
- **Add / remove** competitors manually or via AI discovery
- **Per-competitor insights** — posting cadence, format mix, best hours/days (IST), top themes, hashtag strategy, trending audio, top caption hooks
- **Heatmap** — day × hour posting density with engagement overlay
- **Landscape view** — aggregate stats, white-space hours, common themes/hashtags
- **AI strategy panel** — do/don't lists, posting plan (frequency, best days, best times), audience estimate

### LinkedIn (⌘7, link icon)

- **Company cards** — name, industry, HQ, follower count, employee headcount, growth %
- **Sparkline charts** — follower and employee trends over time
- **Landscape aggregate** — total/avg followers, avg headcount, industry breakdown
- **Growth leaderboard** — top follower and headcount gainers
- **AI discovery** — describe your business → get LinkedIn company suggestions

---

## Intelligence Engine Details

### Per-Competitor Intel (`lib/intel/competitor-intel.ts`)

Pure, deterministic analysis from scraped posts and daily metrics:

- **Posts per week** — calculated from post date span (needs ≥2 dated posts)
- **Engagement trend** — % change between first-half and second-half engagement rate
- **Follower growth** — % change over the metrics window
- **Best hours** — IST (India Standard Time, +5:30, no DST) posting hour breakdown by avg engagement
- **Best days** — day-of-week breakdown by avg engagement
- **Heatmap** — non-zero day × hour cells with count and engagement
- **Format mix** — reel vs. carousel vs. image ratio
- **Content themes** — auto-derived from caption + hashtags (install, room-reveal, before-after, acoustics, gear-review, client-story, promo, tips, BTS, event)
- **Hashtag strategy** — most-used hashtags ranked by frequency
- **Top audio** — most-used audio tracks
- **Top hooks** — strongest opening lines from high-engagement posts

### Competitor Discovery (`lib/intel/discover-competitors.ts`)

Zero-config discovery from your existing niche hashtag data:

1. Mines post owners from your tracked hashtag scrapes
2. Scores each owner for India affinity (₹ pricing, city names, +91 numbers)
3. Scores for niche relevance (home AV vocabulary, premium brands, luxury signals)
4. Penalizes off-space accounts (furniture shops, realtors, fashion)
5. Returns top candidates ranked by composite score
6. Auto-adds them and scrapes inline so insights are immediately ready

### LinkedIn Landscape (`lib/intel/linkedin-intel.ts`)

- Growth % from first→last of each company's daily metrics series
- Top follower gainer and headcount gainer identification
- Industry distribution across tracked companies

---

## Environment Variables

```env
# Required for live scraping
APIFY_TOKEN=apify_api_xxx

# Required for AI features (already configured)
GROQ_API_KEY=gsk_xxx

# Optional
OPENROUTER_API_KEY=sk-or-xxx  # fallback LLM provider
```

---

## Setup

1. **Provision tables** — Run `drizzle/0010_trend_competitor_intel.sql` in the Supabase SQL Editor
2. **Add env vars** — Set `APIFY_TOKEN` in `.env.local`
3. **Add competitors** — Open the Competitors tab → click Add → enter Instagram handles
4. **First scrape** — Click Refresh to pull live data, or use AI Discovery to auto-find competitors
5. **LinkedIn** — Open the LinkedIn tab → Add by company URL → Refresh
6. **Crons** — Set up `GET /api/cron/refresh-competitors` and `GET /api/cron/refresh-linkedin` to run daily (Vercel cron or external)

---

## File Inventory

<details>
<summary>51 files changed from main (click to expand)</summary>

**Competitor API Routes (7)**
- `app/api/competitors/route.ts` — list/add competitors
- `app/api/competitors/[id]/route.ts` — delete/patch single competitor
- `app/api/competitors/[id]/insights/route.ts` — deep per-competitor insights
- `app/api/competitors/discover/route.ts` — AI competitor discovery
- `app/api/competitors/landscape/route.ts` — cross-competitor landscape
- `app/api/competitors/refresh/route.ts` — manual competitor refresh
- `app/api/cron/refresh-competitors/route.ts` — scheduled competitor cron

**LinkedIn API Routes (5)**
- `app/api/linkedin/route.ts` — list/add LinkedIn companies
- `app/api/linkedin/[id]/route.ts` — delete single company
- `app/api/linkedin/discover/route.ts` — AI LinkedIn discovery
- `app/api/linkedin/refresh/route.ts` — manual LinkedIn refresh
- `app/api/cron/refresh-linkedin/route.ts` — scheduled LinkedIn cron

**Intelligence (14)**
- `lib/intel/competitor-intel.ts` — per-competitor rollup engine (pure)
- `lib/intel/discover-competitors.ts` — AI competitor discovery from hashtag data
- `lib/intel/discover-linkedin.ts` — LinkedIn AI company discovery
- `lib/intel/refresh-competitors.ts` — scrape → DB competitor orchestration
- `lib/intel/refresh-linkedin.ts` — scrape → DB LinkedIn orchestration
- `lib/intel/linkedin-intel.ts` — LinkedIn landscape analysis (pure)
- `lib/intel/strategist.ts` — LLM strategy generation (do/don't, plans)
- `lib/intel/llm.ts` — Groq/OpenRouter shared client + cache
- `lib/intel/cross-platform-radar.ts` — cross-platform gap detection (shared)
- `lib/intel/cross-platform.ts` — cross-platform opportunities (shared)
- `lib/intel/forecast.ts` — trend lifecycle forecasting (shared)
- `lib/intel/general-trends.ts` — broad market buckets (shared)
- `lib/intel/targeting.ts` — audience targeting (shared)
- `lib/intel/creator-audit.ts` — creator analysis (shared)

**Scrapers (8)**
- `lib/scrapers/competitors.ts` — IG profile + posts scraper
- `lib/scrapers/stories.ts` — IG story count scraper
- `lib/scrapers/linkedin.ts` — LinkedIn company detail scraper
- `lib/scrapers/apify-client.ts` — shared Apify run-sync client
- `lib/scrapers/apify.ts` — IG hashtag scraper (shared)
- `lib/scrapers/tiktok.ts` — TikTok scraper (shared)
- `lib/scrapers/youtube.ts` — YouTube scraper (shared)
- `lib/scrapers/dummy.ts` — offline fallback
- `lib/scrapers/registry.ts` — scraper registration
- `lib/scrapers/types.ts` — shared scraper types

**Analysis (4)**
- `lib/taccv/trend-analysis.ts` — engagement scoring (shared)
- `lib/taccv/ai-summary.ts` — AI narrative (shared)
- `lib/taccv/refresh.ts` — scrape orchestration (shared)
- `lib/taccv/creator-analysis.ts` — creator analysis (shared)

**Utilities (4)**
- `lib/text/hashtag.ts` — hashtag normalization
- `lib/text/truncate.ts` — text truncation
- `lib/usage.ts` — metered API usage tracking
- `lib/ui/fetcher.ts` — SWR fetcher utilities

**UI (3)**
- `components/competitors/competitors-dashboard.tsx` — Instagram competitor dashboard
- `components/competitors/linkedin-dashboard.tsx` — LinkedIn company dashboard
- `components/spark.tsx` — sparkline chart component
- `components/shell.tsx` — navigation tab additions

**Database (2)**
- `lib/db/schema.ts` — +13 Drizzle table definitions
- `drizzle/0010_trend_competitor_intel.sql` — migration SQL

**Dashboard (1)**
- `app/dashboard/page.tsx` — tab routing update

</details>
