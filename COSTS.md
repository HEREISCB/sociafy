# Cost model — Sociafy AI/API spend (2026-05)

All numbers below are **provider cost**. The "+10%" column adds a safety
margin so we never lose money on a single action.

Models locked in:
- **OpenAI gpt-5** + **gpt-5-mini** for text
- **OpenAI gpt-image-2** for image generation (GA May 2026, snapshot `gpt-image-2-2026-04-21`)
- **ByteDance Seedance 2.0** via PiAPI for video generation
- **Brave Search API** for web search (since we don't have an Anthropic key)
- **Proxycurl** for LinkedIn enrichment (optional, fallback to Brave site:linkedin.com)

> ⚠ Provider prices change. Verify against the canonical sources before any pricing announcement:
> - https://openai.com/api/pricing/
> - https://piapi.ai/docs/seedance-api/seedance-2
> - https://api-dashboard.search.brave.com/documentation/pricing
> - https://nubela.co/proxycurl/pricing.html

## Text generation (per call estimate)

Assumes typical token usage per loop. Loops with tools max out higher.

| Action | Provider | Cost | + 10% |
|---|---|---|---|
| Compose (fast, no tools) | gpt-5-mini, 3k in / 1k out | $0.003 | **$0.0033** |
| Compose (with research) | gpt-5 + 2× Brave + 5k loop | $0.024 | **$0.026** |
| Daily agent draft | gpt-5 + 3× Brave + 7k loop | $0.038 | **$0.042** |
| Research endpoint | gpt-5 + 3× Brave + 6k loop | $0.032 | **$0.035** |
| Brand monitor | gpt-5 + 4× Brave + 8k loop | $0.044 | **$0.048** |

Token reference:
- gpt-5: $1.25/M input, $10.00/M output
- gpt-5-mini: $0.25/M input, $2.00/M output

## Image generation — `gpt-image-2`

Token-based billing under the hood (priced via image input/output tokens),
flat per-image figures below come from OpenAI's calculator.
**Batch API = 50% off** if we queue overnight.

| Resolution | Low | Medium | High |
|---|---|---|---|
| 1024×1024 | $0.006 | $0.053 | $0.211 |
| 1024×1536 (portrait) | $0.005 | $0.041 | $0.165 |
| 1536×1024 (landscape) | ~$0.005 | ~$0.041 | ~$0.165 |
| 2K (1920×1080-ish) | — | — | ~$0.30+ |
| 4K **beta** | — | — | ~$0.41 |

| Resolution | + 10% Low | + 10% Medium | + 10% High |
|---|---|---|---|
| 1024×1024 | $0.0066 | **$0.058** | $0.232 |
| 1024×1536 | $0.0055 | **$0.045** | $0.182 |
| 1536×1024 | $0.0055 | **$0.045** | $0.182 |
| 4K (beta) | — | — | **$0.451** |

Endpoint: `POST /v1/images/generations`. Same SDK as text.

## Video generation — Seedance 2.0 (PiAPI)

**Pricing is per second × resolution**, not per call. Duration: integer 4–15s.

| Model | 480p | 720p | 1080p |
|---|---|---|---|
| `seedance-2` (quality) | $0.10/s | $0.20/s | $0.50/s |
| `seedance-2-fast` | $0.08/s | $0.16/s | not supported |

| Duration / Resolution | Cost | + 10% |
|---|---|---|
| seedance-2-fast @ 480p × 5s | $0.40 | **$0.440** |
| seedance-2-fast @ 720p × 5s | $0.80 | **$0.880** |
| seedance-2 @ 480p × 5s | $0.50 | **$0.550** |
| seedance-2 @ 720p × 5s | $1.00 | **$1.100** |
| seedance-2 @ 720p × 10s | $2.00 | **$2.200** |
| seedance-2 @ 1080p × 5s | $2.50 | **$2.750** |
| seedance-2 @ 1080p × 10s | $5.00 | **$5.500** |

**Video-to-video adds**: `(unit_price ÷ 2) × input_duration` on top.

Note: Seedance is ~3–5× the cost of Kling. The 1080p 10s tier is **$5
provider cost** — for a single video. Recommend defaulting to
`seedance-2-fast @ 720p` for most user-initiated generations and unlocking
quality/1080p as a Pro-tier feature only.

## Web search

| Provider | Cost | + 10% | Notes |
|---|---|---|---|
| Brave Search API | $0.005/q | **$0.0055** | After $5 min/mo. Recommended default. |
| Tavily basic | $0.008/q | $0.0088 | AI-optimized snippets, 1k/mo free. |
| SerpAPI | $0.015/q | $0.0165 | Most accurate, 3× the price. |

## LinkedIn enrichment

| Provider | Cost | + 10% | Notes |
|---|---|---|---|
| Brave `site:linkedin.com/in/<x>` | $0.005/q | $0.0055 | Cheapest, no ToS risk, partial content. |
| Proxycurl Person Profile | $0.010/call | **$0.011** | Up to 10 recent public posts bundled in. |
| Proxycurl Company Insights | $0.100/call | $0.110 | Headcount, growth signals, etc. |
| Proxycurl Employee Search | $0.10 + $0.06 per result | + 10% | Use sparingly. |

## Webhook ingestion / refresh / publish

| Action | Cost | Note |
|---|---|---|
| Webhook event ingest | ~$0 | own infra, only DB writes |
| Token refresh | ~$0 | own infra + free platform endpoints |
| Publish to FB/IG/X/TT/LI | ~$0 | platform API calls are free at our usage |

## Suggested tier pricing

Adjusted for Seedance's higher video cost.

| Tier | $/mo | Bundle (rough) |
|---|---|---|
| **Starter** | $19 | 200 compose · 30 images medium · 3 videos `seedance-2-fast @ 720p × 5s` · 100 web searches |
| **Pro** | $59 | 600 compose · 150 images mixed · 15 videos (any mode @ 720p × 5s) · 500 searches · daily brand monitor |
| **Scale** | $199 | Unlimited compose · 500 images including 4K · 60 videos (incl. 1080p × 10s) · LinkedIn scraping · priority support |

**Margins** (assuming average usage at 60% of quota):
- Starter $19 → provider cost ~$6 → 68% gross margin
- Pro $59 → provider cost ~$22 → 63% gross margin
- Scale $199 → provider cost ~$80 → 60% gross margin

## Server-side hard caps (already enforced or to add)

In place:
- `publish`: 8/min/user
- `agentRun` (covers compose-with-research, research, brand-monitor): 3 per 5 min/user
- `oauthStart`: 20/min/user + 20/min/IP
- `webhook`: 120/min/IP

To add when wiring the new providers:
- `image-gen`: 6/min/user (cheap per call but easy to abuse)
- `video-gen`: 2/min/user — and require tier check before allowing 1080p or duration > 5s
- `linkedin-scrape`: 30/min/user (also capped by Proxycurl quota itself)
- `web-search`: 30/min/user
- Hard daily $-budget per user, soft-warn at 80%, hard-stop at 100%

## Worst-case single-action cost

For monitoring / abuse detection:

| Action | Worst case (one call) |
|---|---|
| Agent loop (max steps + max tokens + max searches) | ~$0.23 |
| gpt-image-2 4K high | ~$0.41 |
| Seedance 2.0 1080p × 15s | $7.50 |
| Proxycurl Employee Search × 50 results | $0.40 |

Recommend a global per-user **daily AI spend cap** (e.g. $5 Starter, $20 Pro,
$100 Scale) checked before any paid call. Track in a `usage_meter` table.
