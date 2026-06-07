# Sociafy Pricing & Credit System — v3

_Last updated: 2026-05-21 · Major revision: PiAPI Seedance pricing scales steeply with resolution (1080p is 5× the cost of 480p). 720p is now the default video tier; 1080p positioned as a premium "hero clip" tier-locked to Business + above._

---

## 1. What we're paying for

### 1.1 Variable cost APIs (usage-based)

| Service | Used for | 2026 pricing |
|---|---|---|
| **OpenAI GPT-5** | Caption variants with `withTools=true`; autopilot trend → draft | $1.25 / 1M input tokens, $10 / 1M output tokens |
| **OpenAI GPT-5-mini** | Caption variants (default), prompt rewriter for image and video gen | $0.25 / 1M input tokens, $2.00 / 1M output tokens |
| **OpenAI Web Search tool** | "With research" caption mode, autopilot trend verification | Tool call + ~8K-token block at the calling model's rate |
| **OpenAI gpt-image-1 (1024×1024)** | Image generation, square | Low: $0.009 · Medium: $0.034 · High: $0.133 per image |
| **OpenAI gpt-image-1 (portrait/landscape)** | Image generation, vertical/horizontal | Low: $0.013 · Medium: $0.051 · High: $0.20 per image |
| **PiAPI Seedance 2.0 — 480p** | Video generation, Quality model | $0.10 per second |
| **PiAPI Seedance 2.0 — 720p** | Video generation, Quality model | $0.20 per second |
| **PiAPI Seedance 2.0 — 1080p** | Video generation, Quality model | $0.50 per second |
| **PiAPI Seedance-2-Fast — 480p** | Video generation, Fast model | $0.08 per second |
| **PiAPI Seedance-2-Fast — 720p** | Video generation, Fast model | $0.16 per second |

### 1.2 Platform publishing API costs

| Platform | Cost |
|---|---|
| **X (Twitter)** | $200/month for X API Basic — covers ~3,000 posts/month app-wide |
| **LinkedIn / Meta / TikTok / YouTube** | Free for OAuth user-posted content |

X is the only paid platform. Amortized at ~$2-4/user/month at small scale.

### 1.3 Fixed infrastructure (baseline)

| Service | Cost |
|---|---|
| Cloudflare R2 (storage) | $0.015 / GB / month (~$3/month per active video-user at scale) |
| Supabase Postgres Pro | $25 / month flat |
| Vercel hosting | $20 / month flat |
| Clerk Auth | Free up to 10K MAU |
| **Total baseline** | **~$45 / month + $3 per active user with video** |

---

## 2. Cost per user action (real numbers)

### 2.1 Per-action cost (what Sociafy pays providers)

| Action | Detail | **Our cost** |
|---|---|---:|
| Text post (no tools) | GPT-5-mini variants + per-platform | **$0.005** |
| Text post (with research) | GPT-5 + web_search tool | **$0.050** |
| Image (low, 1024) | GPT-5-mini rewriter + gpt-image-1 low | **$0.010** |
| Image (medium, 1024) | GPT-5-mini rewriter + gpt-image-1 medium | **$0.035** |
| Image (medium portrait/landscape) | GPT-5-mini rewriter + gpt-image-1 medium portrait | **$0.052** |
| Image (high, 1024) | GPT-5-mini rewriter + gpt-image-1 high | **$0.134** |
| Image (high portrait/landscape) | GPT-5-mini rewriter + gpt-image-1 high portrait | **$0.201** |
| Video (8s, 480p, Fast) | rewriter + Seedance-fast-480p | **$0.641** |
| Video (8s, 480p, Quality) | rewriter + Seedance-2-480p | **$0.801** |
| Video (8s, 720p, Fast) | rewriter + Seedance-fast-720p | **$1.281** |
| Video (8s, 720p, Quality) | rewriter + Seedance-2-720p | **$1.601** |
| Video (8s, 1080p, Quality) | rewriter + Seedance-2-1080p | **$4.001** |
| Video (15s, 720p, Quality) | rewriter + Seedance-2-720p | **$3.001** |
| **Video (15s, 1080p, Quality)** | **rewriter + Seedance-2-1080p** | **$7.501** |
| + X publishing surcharge per X post | Amortized X API Basic | $0.067 |
| R2 storage per video (avg 30MB) | — | $0.0005 (negligible per post) |

> **The 1080p reality check**: a single 15-second 1080p video costs us $7.50 to generate. That's why we default to 720p (already what Reels, Shorts, and TikTok compress to) and gate 1080p as a "hero clip" feature for Business-tier headroom.

---

## 3. Credits

### 3.1 Definition

> **1 credit = $0.009 of our raw cost. Retail $0.013 per credit (top-ups/overage).**

Subscription tiers offer slight discounts off this base rate as you upgrade.

### 3.2 Per-action credit cost (customer-facing)

| Action | Credits | Customer value | Our cost | Margin |
|---|---:|---:|---:|---:|
| Text post | **1** | $0.013 | $0.005 | 62% |
| Text + research | **6** | $0.078 | $0.050 | 36% |
| Image (low 1024) — gpt-image-2 | **2** | $0.030 | $0.011 | 63% |
| Image (medium 1024) — gpt-image-2 | **6** | $0.090 | $0.058 | 36% |
| Image (medium portrait/landscape) | **6** | $0.090 | $0.046 | 49% |
| Image (high 1024) — gpt-image-2 | **24** | $0.360 | $0.216 | 40% |
| Image (high portrait/landscape) | **23** | $0.345 | $0.170 | 51% |

> **Image model = gpt-image-2** (`OPENAI_IMAGE_MODEL`). Unlike gpt-image-1, on gpt-image-2 the **square** medium/high tiers cost MORE than portrait/landscape, so square credit prices are now ≥ their portrait counterparts. Customer value uses the $0.015 top-up rate; margins shown stay positive at the Business $0.012/credit rate too.
| Video 8s 480p Fast | **75** | $0.975 | $0.641 | 34% |
| Video 8s 480p Quality | **90** | $1.170 | $0.801 | 32% |
| Video 8s 720p Fast | **145** | $1.885 | $1.281 | 32% |
| **Video 8s 720p Quality (DEFAULT REEL)** | **180** | $2.340 | $1.601 | **32%** |
| Video 8s 1080p Quality (hero) | **445** | $5.785 | $4.001 | 31% |
| Video 15s 720p Quality | **335** | $4.355 | $3.001 | 31% |
| Video 15s 1080p Quality (premium hero) | **835** | $10.855 | $7.501 | 31% |
| Variant regenerate (caption only) | **1** | $0.013 | $0.005 | 62% |

All per-action margins are now **positive at all tier discount levels** — including at the Business-tier $0.012/credit rate. No bleed scenarios.

### 3.3 Voice & Avatar (Modal GPU-hosted)

Voice cloning (clone-TTS) and the talking-avatar video run on our own Modal GPU
containers, not a per-call API. Cost = container time billed per second
(**L4 $0.000222/s ≈ $0.80/hr**, **L40S $0.000542/s ≈ $1.95/hr**), dominated by
model load + scaledown idle. Priced off measured worst-case (isolated, cold)
cost. Idle windows trimmed to avatar 90s / voice 60s to cut launch-volume waste.

| Action | Credits | Cust. value (top-up $0.015) | Our cost (worst-case) | Margin @ Business ($0.012) |
|---|---:|---:|---:|---:|
| Voice Twin create (one-time) | **10** | $0.150 | ~$0.05 (L4) | $0.07 → 58% |
| Text-to-speech (clone) | **8** | $0.120 | ~$0.05 (L4) | $0.046 → 48% |
| Avatar video · 480p | **50** | $0.750 | ~$0.30 (L40S+L4) | $0.30 → 50% |
| Avatar video · 720p | **90** | $1.350 | ~$0.50 (L40S+L4) | $0.58 → 54% |

> Avatar in "Voice Twin" mode runs the clone-TTS step internally on the L4 and
> the LTX render on the L40S; the avatar credit price covers BOTH (no separate
> TTS charge). Avatar is our highest-margin media action.

---

## 4. Subscription tiers (v3)

Three tiers. **All include full media generation** (text, image, video). **No free tier, no free trial.** Credits roll over for one month (Business: two months). Overage billed at $0.015/credit.

### 4.1 Starter — **$30 / month**

- **2,000 credits / month** at $0.015/credit effective
- All 6 platforms — X · LinkedIn · Instagram · Facebook · TikTok · YouTube
- All compose modes — text, image, 720p video
- Manual posting + scheduling
- **No autopilot** (manual-only)
- 1-month credit rollover
- Email support

**Recommended use mix (well under budget):**
- 30 text posts + 60 medium images + 6 short 720p videos
- = 30 + 240 + 1,080 = **1,350 credits** (650 to spare)

**Who it's for:** solo creators, side-project marketers, anyone shipping a few posts a week with media but no automation needs.

**Our cost**: 2,000 × $0.009 + $2 X + $0.5 infra = **$20.50** → margin $9.50 (32%)

---

### 4.2 Pro — **$80 / month**

- **6,000 credits / month** at $0.013/credit effective (11% better than Starter)
- All 6 platforms
- All compose modes including 720p video at Quality
- **Autopilot enabled** — trend → draft → schedule
- Web research on captions (`withTools` mode)
- Per-platform + per-content-type quotas
- 1-month credit rollover
- Priority email support

**Recommended use mix:**
- Daily image (30 × 4 = 120) + 18 720p Quality videos (18 × 180 = 3,240) + 60 text (60) + 20 research posts (120)
- = **3,540 credits** (2,460 to spare for autopilot + experimentation)

**Who it's for:** indie founders, newsletter operators, SaaS marketers running daily social with regular video.

**Our cost**: 6,000 × $0.009 + $3 X + $1 infra = **$58** → margin $22 (28%)

---

### 4.3 Business — **$299 / month**

- **25,000 credits / month** at $0.012/credit effective (20% better than Starter, 10% better than Pro)
- All 6 platforms
- All compose modes including **1080p hero video**
- **Autopilot with media generation** — autopilot can submit image and video gen jobs within content-type quotas
- Web research on every post
- "Daily 720p reel" guarantee — 30 × 8s 720p Quality videos/month + 5 × 1080p hero videos/month + everything else
- 2-month credit rollover
- Priority support + onboarding call

**The "daily reel + hero content + active business" target:**

| Activity | Frequency | Credits/month |
|---|---|---:|
| **Daily 720p Quality reel** (8s) | 30 / month | 30 × 180 = **5,400** |
| **Hero 1080p video** (15s premium) | 5 / month | 5 × 835 = **4,175** |
| Daily image (medium 1024) | 30 / month | 30 × 4 = **120** |
| Hero image (high 1024) | 8 / month | 8 × 15 = **120** |
| Daily text post | 30 / month | 30 × 1 = **30** |
| Research-enriched posts | 12 / month | 12 × 6 = **72** |
| Autopilot trend drafts | ~30 / month | 30 × 1 = **30** |
| Variant regenerations | ~150 / month | 150 × 1 = **150** |
| Extra ad-hoc images + carousels | ~300 images | 300 × 4 = **1,200** |
| Second-take videos (Fast 720p) | ~10 / month | 10 × 145 = **1,450** |
| **Total active usage** |  | **~12,747** |
| **Headroom** for autopilot scaling + bursts |  | **~12,253** |

**Who it's for:** brands with content calendars, agencies running client accounts, anyone treating Sociafy as their primary social ops surface and posting daily across all platforms.

**Our cost**: 25,000 × $0.009 + $4 X + $5 R2 + $0.50 infra = **$234.50** → margin $64.50 (22%)

---

### 4.4 Quick comparison

| | Starter | Pro | Business |
|---|---:|---:|---:|
| **Monthly price** | **$30** | **$80** | **$299** |
| **Credits / month** | 2,000 | 6,000 | **25,000** |
| **Effective $/credit** | $0.0150 | $0.0133 | **$0.0120** |
| **Discount vs Starter** | baseline | 11% | **20%** |
| **All 6 platforms** | ✓ | ✓ | ✓ |
| **Text + image + video gen** | ✓ | ✓ | ✓ |
| **720p reels** | ~11/month | ~33/month | 30 + extras |
| **1080p hero clips** | available (445 cr each) | available | **5 included + extras** |
| **Autopilot** | — | ✓ | ✓ with media gen |
| **Web research on captions** | available (6 cr each) | ✓ | ✓ |
| **Credit rollover** | 1 month | 1 month | 2 months |
| **Our gross margin** | 32% | 28% | 22% |
| **Free trial** | None | None | None |

### 4.5 Concrete capacity per tier (the "how many videos do I get" question)

**Starter ($30, 2,000 credits)**:
- Up to 27 fast 480p reels (8s) OR
- Up to **11** standard 720p Quality reels (8s) OR
- Up to 6 long 720p Quality reels (15s) OR
- 4-5 premium 1080p hero clips (15s)
- More realistic: 30 text + 60 images + 6 reels per month

**Pro ($80, 6,000 credits)**:
- Up to 82 fast 480p reels (8s) OR
- Up to **33** standard 720p Quality reels (8s) — daily reels feasible OR
- Up to 7 premium 1080p hero clips (15s)
- More realistic: daily image + 15-20 reels + research + autopilot drafts

**Business ($299, 25,000 credits)**:
- **30 daily 720p Quality reels guaranteed** + **5 premium 1080p hero clips/month** + everything else
- OR up to ~138 reels at 720p Quality if all-in on video
- OR up to ~29 premium 1080p hero clips/month
- Designed for daily-publishing brands and agencies

### 4.6 Overage

When a tier exceeds its allocation:
1. **Top up**: $15 per 1,000 credits (any tier, applies immediately)
2. **Upgrade**: switch tier mid-cycle, prorated
3. **Hard stop**: credits run out → AI calls fail with `out_of_credits` error; user resumes next billing cycle

---

## 5. Loss / bleed analysis

### 5.1 Per-action margin check

At the **most discounted** rate (Business-tier $0.012/credit):

| Action | Credits | Customer (Business rate) | Our cost | Margin |
|---|---:|---:|---:|---:|
| Text | 1 | $0.012 | $0.005 | 58% ✓ |
| Image medium | 4 | $0.048 | $0.035 | 27% ✓ |
| Image high portrait/landscape | 23 | $0.276 | $0.201 | 27% ✓ |
| Video 8s 720p Quality | 180 | $2.160 | $1.601 | 26% ✓ |
| Video 8s 1080p Quality | 445 | $5.340 | $4.001 | 25% ✓ |
| Video 15s 1080p Quality | 835 | $10.020 | $7.501 | 25% ✓ |
| Video 8s 720p Fast | 145 | $1.740 | $1.281 | 26% ✓ |

**Every action stays positive even at the Business discount.** No per-action bleed.

### 5.2 Where money could still leak

These aren't current losses but they're places to monitor:

1. **YouTube quota at scale.** YouTube Data API caps at 10K units/day per Google Cloud project. Each upload costs ~1,600 units → ~6 uploads/day total. Business users posting daily Shorts will hit this. We need to either request quota increase (free but requires audit + weeks) OR shard OAuth clients across projects (ops overhead). Today: not a money loss; could become a service-quality issue.

2. **X scaling.** $200/mo X Basic covers 3,000 posts/month app-wide. Past ~120 paying users with average usage, we need X Pro ($5,000/mo). The price jump is steep — pricing should adjust ($+10 across all tiers at this scale).

3. **Failed generations we still pay for.** PiAPI charges per task creation, not just per success. If Seedance rate-limits or errors mid-generation, we eat the cost. Need to verify their refund policy and add server-side caching of "completed" task IDs so retries don't pay twice.

4. **Web search inflation.** I estimated 1 search per `withTools` call. If GPT-5 decides to do 3-4 searches in a single agent turn (it can!), each adds an 8K-token block at GPT-5 rates. A single "research" post could spike to $0.15-0.20 of our cost vs. the $0.05 baseline. **Approach**: don't cap — meter actual tool calls and charge dynamically. Base research post = 6 credits (1 search bundled); each additional web_search invocation adds 5 credits to the post's cost. Implementation note: agent loop already tracks `toolsUsed`; we'd extend it to count occurrences and emit a per-call credit ledger entry.

5. **Storage accumulation.** Old generated assets sit in R2 forever unless deleted. At year-1 cumulative: ~30 videos/month × 30MB × 12 months × 100 Business users = ~1 TB → $15/month in storage cost. Manageable, but worth adding a lifecycle policy (e.g., delete unpublished assets after 90 days) before year 2.

6. **Token estimates being too low.** I estimated 1,200 input + 2,400 output for text variants. Brand context + agent instructions + research mode can push this higher. **Mitigation**: enforce `max_output_tokens` cap on every OpenAI call; we already do this in the rewriter (500 tokens) but caption variants should also be capped.

7. **Variant regenerations are loss-leaders at Business rate**. 1 credit ($0.012 at Business) vs. $0.005 our cost = 58% margin. Spamming is rare in practice and each regen still credits the user one. No rate limit — let the credit balance be the natural rate limiter.

### 5.2.bis Dynamic / metered billing — the credit-ledger architecture

We're not implementing per-call accounting yet, but the pricing model assumes it. Notes for when we build it:

- **`credit_ledger` table** keyed by user_id with rows for every billable event: action type, base credits, tool-call surcharge, timestamp, related draft/asset id.
- **Credit balance** = `subscription_allocation - sum(credit_ledger.credits_used) + topups`.
- **Pre-flight check**: every AI route checks `getBalance(userId)`; if &lt; estimated max cost → 402 `insufficient_credits` before calling the API.
- **Post-flight reconcile**: after the API call returns, count actual tool calls from `toolsUsed`, write the final ledger row with the true cost.
- **Failure refund**: if the API errors out, write a refund entry (negative credits) so users don't pay for failed generations.
- **UI**: a thin credit-meter component in the top nav + a "View usage" page that lists the ledger.

This is a separate ~1-day feature once the tier subscription system is in place.

### 5.3 Net margin reality

After Stripe (3%) + fixed infra share + the variable costs above:

| Tier | Revenue | Variable | Stripe | Infra share | **Net** | **Margin** |
|---|---:|---:|---:|---:|---:|---:|
| Starter | $30 | $20.00 | $0.90 | $0.50 | **$8.60** | **29%** |
| Pro | $80 | $58.00 | $2.40 | $0.50 | **$19.10** | **24%** |
| Business | $299 | $234.50 | $8.97 | $0.50 | **$55.03** | **18%** |

Real margins assume users burn 100% of credits. In practice, typical SaaS utilization is 60-80% — actual realized margins are 30-50% better than the table above.

### 5.4 Break-even at 50/30/20 (Starter/Pro/Business) mix

- Avg revenue per user: $98.80
- Avg variable cost per user: $66.30
- Net per user: ~$15/month after Stripe + infra share
- Break-even on $5K/month founder-only cost: **~340 users**
- Break-even on $25K/month team-of-2 cost: **~1,700 users**

---

## 6. Pricing levers (optional, not in v3 default)

1. **Annual prepay**: 2 months free (16.7% off). Drives cash flow + commitment.
2. **Business "Unlimited" tier**: $799/month, soft-unlimited credits with fair-use throttling. For agencies managing 5+ brand accounts.
3. **Per-seat pricing on Business**: $19/month per additional seat (planned, post-MVP).
4. **Custom-trained voice model add-on**: $99 one-time + $0.002/1K tokens premium.
5. **Developer API access**: $500/month flat + usage. Adjacent revenue stream.

---

## 7. TL;DR landing page copy

> **Starter $30/mo · Pro $80/mo · Business $299/mo**
>
> Every action is a credit. Text = 1 credit · Image (medium) = 4 credits · 720p reel (default) = 180 credits · 1080p hero clip = 835 credits. Top up at $15 per 1,000 credits. Upgrade anytime. No free trial.

---

## Sources

- [OpenAI API Pricing](https://openai.com/api/pricing/)
- [GPT-5 Mini Pricing — PricePerToken](https://pricepertoken.com/pricing-page/model/openai-gpt-5-mini)
- [GPT-5 Pricing — PricePerToken](https://pricepertoken.com/pricing-page/model/openai-gpt-5)
- [GPT-Image-1 Pricing — IntuitionLabs](https://intuitionlabs.ai/articles/ai-image-generation-pricing-google-openai)
- [PiAPI Seedance 2.0 Pricing (per-resolution)](https://piapi.ai/seedance-2-0)
- [X (Twitter) API tier pricing](https://developer.x.com/en/portal/products/basic)
