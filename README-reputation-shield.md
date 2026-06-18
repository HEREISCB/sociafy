# Reputation Shield — Service Documentation

Reputation Shield is a brand monitoring and crisis-response feature built into Sociafy. It watches the internet for negative coverage about your brand, scores the sentiment, and surfaces a draft response for you to approve and publish — all within the dashboard.

---

## What It Does

1. **Monitors** brand mentions across multiple sources (news, communities, social)
2. **Scores** each mention for sentiment (crisis / negative / neutral / positive) using a keyword model
3. **Generates** an AI-written response script via OpenAI (falls back to templates if no key)
4. **Surfaces** negative/crisis mentions as actionable items in the Reputation Shield dashboard tab
5. **Publishes** your approved response to connected social platforms in one click

---

## Data Sources

| Tier | Source | Auth | Notes |
|------|--------|------|-------|
| Free | **Google News RSS** | None | Up to 100 results per query. Controversy query also run (adds `OR scandal OR lawsuit OR fail`) |
| Free | **Hacker News** (Algolia) | None | Top 30 stories matching brand query |
| Free | **Wikipedia** | None | Controversy + lawsuit search queries, 8 results each |
| OAuth | **Reddit** | Reddit app (PKCE-less OAuth2) | Searches posts + comments via `/oauth.reddit.com/search`; requires `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` |
| OAuth | **X / Twitter** | Bearer token from connected account | Recent tweet search (`/2/tweets/search/recent`); uses token from the user's connected X account |

### Planned / Tier 2
Trustpilot, G2, Capterra, Product Hunt — no official free APIs; planned via web-search proxy.

---

## Sentiment Pipeline

**File**: `lib/shield/sentiment.ts` → `scoreMention(title, body)`

1. Tokenises combined title + body
2. Matches against three word-sets: `CRISIS` (×3 weight), `NEGATIVE`, `POSITIVE`
3. Raw score = `positive_count − negative_count − crisis_count × 3`
4. Labels: crisis if any crisis word found; negative if score < −1 or ≥2 negative words; else positive/neutral
5. Detects theme: Data Security, Legal Action, Fraud/Deception, Pricing, Product Quality, Customer Support, Workplace Issues, Discrimination, Competitor Comparison, Environmental, General Reputation

---

## Approval Flow

```
Cron runs every 15 min
  └─ runShieldScan(userId, brand)
       ├─ Fetch all sources in parallel
       ├─ Score sentiment
       ├─ Dedup against DB (externalId)
       ├─ Insert new mentions (mentions table)
       └─ For each crisis/negative:
            ├─ Generate response script (OpenAI or template)
            └─ Insert shieldActions row (status = pending)

Dashboard "Reputation Shield" tab
  └─ Shows pending actions as MentionCards
       ├─ User edits script
       ├─ Selects target platform (optional)
       └─ Clicks "Approve & Publish"
            └─ POST /api/shield/actions/:id/approve
                 ├─ Calls platform adapter publishText()
                 └─ Logs to activityLog (kind = shield_response_published)
```

---

## Platform Publish Coverage

When a user approves a response, it can be published to any connected platform:

| Platform | Action | Notes |
|----------|--------|-------|
| X | New tweet | 280 char limit enforced by platform |
| LinkedIn | Member post | Text only |
| Facebook | Page post | Requires connected Facebook Page |
| Instagram | — | Monitoring only (no text-only post API) |
| Reddit | Comment reply | Requires `parentId` in meta; or new post to subreddit |
| TikTok | — | Video-only platform |
| YouTube | — | Monitoring only |

---

## Database Tables

### `mentions`
Stores every unique brand mention fetched from any source.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| userId | text | Clerk user ID |
| brand | text | The brand/query that was scanned |
| source | text | google_news / hackernews / wikipedia / reddit / x / own_post |
| externalId | text | Dedup key (url hash or platform post ID) |
| sentimentLabel | text | crisis / negative / neutral / positive |
| severity | int | 1–10 |
| theme | text | Category of the issue |

### `shield_actions`
One row per negative/crisis mention — tracks the user's response lifecycle.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| mentionId | uuid FK | → mentions.id |
| status | text | pending / approved / rejected / published / failed |
| script | text | AI-generated (or user-edited) response draft |
| targetPlatform | text | Platform to publish to |
| publishedPostId | text | Platform's returned post ID after publish |

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/shield/scan` | Clerk | Trigger an on-demand scan for a brand |
| GET | `/api/shield/actions` | Clerk | List shield actions (filter by status) |
| PATCH | `/api/shield/actions/:id` | Clerk | Update draft script / target platform |
| POST | `/api/shield/actions/:id/approve` | Clerk | Approve + publish response |
| POST | `/api/shield/actions/:id/reject` | Clerk | Dismiss the action |
| GET | `/api/cron/shield-monitor` | CRON_SECRET | Cron endpoint — scans all active users |
| POST | `/api/demo/shield/scan` | None | Public demo — returns scored mentions |
| POST | `/api/demo/shield/script` | None | Public demo — generates response script |

---

## Environment Variables

Add these to `.env.local`:

```bash
# Reddit OAuth app (register at https://www.reddit.com/prefs/apps)
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
# Redirect URI to register in the Reddit app:
# http://localhost:3000/api/oauth/reddit/callback  (dev)
# https://yourdomain.com/api/oauth/reddit/callback  (prod)

# Cron authentication (already used by other crons)
CRON_SECRET=your_cron_secret

# OpenAI (optional — enables AI-generated scripts; falls back to templates)
OPENAI_API_KEY=sk-...
```

---

## Running Locally

```bash
# 1. Install dependencies (if not already)
npm install

# 2. Start the dev server
npm run dev

# 3. Visit the public demo (no sign-in needed)
open http://localhost:3000/demo/shield

# 4. Visit the full dashboard tab (sign-in required)
open http://localhost:3000/dashboard?tab=shield

# 5. Sync the new DB tables (requires DATABASE_URL in .env.local)
npm run db:push

# 6. Connect Reddit (requires REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET)
#    Go to Dashboard → Connections → Reddit → Connect

# 7. Trigger a manual scan
curl -X POST http://localhost:3000/api/shield/scan \
  -H "Content-Type: application/json" \
  -d '{"brand":"YourBrandName"}'
  # (must be signed in via cookie — use browser devtools Network tab instead)

# 8. Test the cron endpoint
curl -H "Authorization: Bearer dev-cron-secret-change-me" \
  http://localhost:3000/api/cron/shield-monitor
```

---

## File Map

```
lib/
  shield/
    sentiment.ts     — scoreMention() keyword sentiment engine
    script.ts        — generateScript() OpenAI + template fallback
    sources.ts       — all source fetchers (News, HN, Wiki, Reddit, X)
    monitor.ts       — runShieldScan() orchestrator

  platforms/
    reddit.ts        — Reddit OAuth adapter + searchRedditMentions()

  db/schema.ts       — mentions + shieldActions tables (appended)

app/
  api/
    shield/
      scan/route.ts               — on-demand scan endpoint
      actions/route.ts            — list actions
      actions/[id]/approve/       — approve + publish
      actions/[id]/reject/        — dismiss
      actions/[id]/route.ts       — PATCH (edit script)
    cron/
      shield-monitor/route.ts     — 15-min cron scan
    demo/shield/
      scan/route.ts               — public demo scan
      script/route.ts             — public demo script gen

  demo/shield/page.tsx            — public demo page (light theme)
  dashboard/page.tsx              — adds 'shield' tab

components/
  shield/
    MentionCard.tsx               — single mention card with approve/reject
    ShieldDashboard.tsx           — full shield dashboard UI
  connections.tsx                 — Reddit card added
  shell.tsx                       — Reputation Shield nav item added
  icons.tsx                       — shield icon added
```
