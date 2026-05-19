# Handoff — AI agent skills + endpoints (2026-05-19, part 2)

Continuation of HANDOFF_2026-05-19.md. While you were out for the second
4-hour block I wired the AI agent with real web access and a set of tools
(skills) it can compose into multi-step workflows. The agent went from a
single-shot Claude call working off a static trends snapshot to a tool-use
loop that can browse the web, read articles, learn from your own engagement
data, and find supporting images.

Three new commits on `main`, all built and typechecked clean:

```
65caa3f Compose research mode + stock image picker + dashboard brand monitor
65fc2c0 Wire AI agent with web access + skills
2401ddd HANDOFF doc + small cleanup            (from previous session)
```

## What's new — at the agent layer

### Tool-use loop ([lib/ai/agent-loop.ts](lib/ai/agent-loop.ts))
A generic `runAgentLoop()` that:
- Calls Claude with a `tools` array
- Loops on `stop_reason === 'tool_use'`, dispatches each tool, feeds the result back as `tool_result`, calls again
- Distinguishes **hosted tools** (Anthropic executes them — `web_search_20250305`) from **custom tools** (we execute them — `fetch_url`, `search_images`, `read_recent_posts`)
- Tracks which tools fired during the run so endpoints can return that to the UI
- Capped at 6 steps and 3500 max_tokens by default

### Skills the agent can call

| Skill | Type | What it does |
|---|---|---|
| `web_search` | Hosted | Native Anthropic web search. Up to 3 calls per agent run. Returns cited results Claude grounds its output on. |
| `fetch_url` | Custom | Pulls plaintext from an HTTPS URL. 200KB cap, 10s timeout, SSRF-blocked against private/loopback IPs, strips HTML. |
| `search_images` | Custom | Stock photo search (Unsplash → Pexels → picsum stub). Returns 6 candidates with attribution. |
| `read_recent_posts` | Custom | Reads the **current user's** published posts ranked by engagement so the agent can learn what worked. User-scoped per request. |
| `read_recent_drafts` | Custom | Titles of recent drafts so the agent doesn't duplicate topics. |

All custom skills live under [lib/ai/skills/](lib/ai/skills/).

### Where the skills are wired

- **`draftFromTrends`** — the agent that drafts from a trends snapshot now runs through the tool loop with all five skills available. So a daily agent run can actually verify a trend is still hot, read the source article, look at what worked for the user before, and find a supporting image — in one pass.
- **`generateCompose`** — gained a `withTools: true` flag. Default behavior unchanged (cheap fast path). When the UI sends `withTools=true`, the model gets web_search + fetch_url + read_recent_posts.

## New API endpoints

### `POST /api/agent/research`
Body: `{ topic: string, urls?: string[], angle?: string }`

Agent searches the web (up to 3 calls), optionally reads URLs the user pasted, returns structured notes:
```json
{
  "summary": "…",
  "facts": [{ "claim": "…", "source": "…", "url": "…" }],
  "angles": ["…", "…"],
  "counter": "…",
  "hooks": ["…", "…"]
}
```

### `POST /api/agent/brand-monitor`
Body: `{ brand: string, competitors?: string[], recentDays?: number }`

Returns:
```json
{
  "summary": "…",
  "mentions": [{ "source": "…", "url": "…", "sentiment": "positive|neutral|negative", "snippet": "…" }],
  "competitorMoves": [{ "competitor": "…", "what": "…", "url": "…" }],
  "respondWith": [{ "angle": "…", "draftText": "…" }]
}
```

### `GET /api/media/search?q=&limit=`
Image search proxy. Tries Unsplash → Pexels → picsum.photos stub. Keeps keys server-side. Returns up to 12 candidates with attribution lines.

All three are gated through `withUser` (signed in only), rate-limited via the existing `agentRun` / `general` buckets, and validate input via zod (open-redirect / DoS hardening from the previous session covers them).

## New UI

### Compose page
- **"Generate with research"** button next to the existing Generate. Sends `withTools=true`. Toast surfaces which tools fired (e.g. `"Researched with web_search + fetch_url before drafting"`).
- **Stock image picker**. Click the "Stock" tile in the media grid → inline panel with search input → grid of Unsplash/Pexels results. Click to attach. Pre-seeds the query from the compose prompt.

### Dashboard
- **Brand monitor card**. Brand name + optional comma-separated competitors → Scan → summary + recent mentions (with sentiment) + suggested reply drafts. Render is read-only; pulling a suggested draft into compose is a one-line follow-up I haven't done — current UX is copy-paste.

## Env vars you may want to add (all optional)

```bash
# Stock image providers — without these, /api/media/search falls back to
# picsum.photos stubs that work but aren't curated.
UNSPLASH_ACCESS_KEY=    # https://unsplash.com/oauth/applications  (50 req/h free)
PEXELS_API_KEY=         # https://www.pexels.com/api/              (200 req/h free)
```

Web search is included in your existing Anthropic billing (~$0.01 per search call). The loop is capped at 3 web_search uses per agent invocation, so a research call costs ≲ $0.03 + ~5k tokens of Sonnet usage.

## Cost & rate-limit awareness

Tool use multiplies token cost because each tool result feeds back into the next message. Concrete cap per call:

| Endpoint | Cap |
|---|---|
| `POST /api/agent/research` | 3 web searches + 6 model turns + 3000 max_tokens |
| `POST /api/agent/brand-monitor` | 4 web searches + 7 model turns + 3500 max_tokens |
| `POST /api/compose/variants` with `withTools=true` | 2 web searches + 5 turns + 2500 max_tokens |
| `draftFromTrends` (daily agent run) | 3 web searches + 6 turns + 3500 max_tokens |

User-level rate limits (from previous session) apply on top:
- `agentRun` bucket: 3 per 5 minutes — covers research, brand-monitor, compose-with-tools, agent/run.
- `general` bucket: 60/min — covers image search.

Bottom line: an actively-using single user can't cost more than a few cents per minute. Worth keeping an eye on if you launch widely.

## Quick test plan

```powershell
# 1. Restart dev server to pick up the new ENV vars
pnpm dev

# 2. Research endpoint — should make 2-3 web_search calls
curl -X POST http://localhost:3000/api/agent/research `
     -H "Content-Type: application/json" `
     -H "Cookie: <clerk session>" `
     -d '{"topic": "founder-led growth tactics in 2026"}'

# 3. Brand monitor
curl -X POST http://localhost:3000/api/agent/brand-monitor `
     -H "Content-Type: application/json" `
     -H "Cookie: <session>" `
     -d '{"brand": "Sociafy", "competitors": ["Buffer", "Hootsuite"]}'

# 4. Image search (no key? picsum stubs come back)
curl 'http://localhost:3000/api/media/search?q=coffee+shop+founder' `
     -H "Cookie: <session>"

# 5. Compose with research — open /dashboard, Compose tab,
#    type a prompt, click "Generate with research". Watch the
#    server log for [tool_use] entries.

# 6. Dashboard brand monitor — open /dashboard,
#    scroll to Brand monitor, enter your brand, hit Scan.
```

## What's left in the broader app

Nothing critical. Everything I'd flag from earlier still stands:
- X (Twitter) creds empty + needs paid API tier for posting
- YouTube publishing not implemented (OAuth + analytics work)
- FB multi-page picker (callback picks first page)
- Tests (still zero)
- Multi-instance rate-limit needs Redis swap

Nice-to-haves I considered but didn't ship:
- "Pull suggested reply into compose" one-click from the dashboard brand monitor card
- Persistent research-note storage (currently lives in the response only — user pastes it into compose)
- Image generation (DALL·E / Stability) vs. stock photo search — stock is cheaper and usually better for social
- Engagement-driven trend scoring (cron that re-scores trends based on which related posts of the user perform best)
- Slack/email digest of brand mentions (would need an email/notification primitive)

If you want any of these in the next session, point me at one and I'll execute.

## Files added this session

```
+ lib/ai/agent-loop.ts                   tool-use loop runner + webSearchTool() helper
+ lib/ai/skills/fetch-url.ts             SSRF-blocked URL fetcher
+ lib/ai/skills/images.ts                Unsplash → Pexels → picsum search
+ lib/ai/skills/posts.ts                 read_recent_posts + read_recent_drafts
+ app/api/agent/research/route.ts        topic research endpoint
+ app/api/agent/brand-monitor/route.ts   brand monitoring endpoint
+ app/api/media/search/route.ts          server-side image search proxy
+ HANDOFF_2026-05-19_part2.md            this file

M lib/ai/agent.ts                        draftFromTrends → agent loop
M lib/ai/compose.ts                      generateCompose gains withTools flag
M lib/agent/run.ts                       pass userId through to drafter
M lib/validation.ts                      withTools in composeVariantsSchema
M app/api/compose/variants/route.ts      forward withTools + userId
M components/compose.tsx                 research button, stock image picker
M components/dashboard.tsx               BrandMonitor card
M .env.local                             UNSPLASH_ACCESS_KEY, PEXELS_API_KEY
```

Welcome back.
