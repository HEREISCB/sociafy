# Sociafy — setup

End-to-end playbook: take the deployed scaffolding to a working demo with real OAuth + Claude + media uploads + cron.

## Stack

| Layer | Provider |
|---|---|
| Auth | **Clerk** |
| Database | **Postgres** (any host — Supabase pooler URL, Neon, Railway, etc.) |
| Storage | **Cloudflare R2** (S3-compatible) |
| AI | **Anthropic** (Claude Haiku for variants, Sonnet for the agent) |
| Cron | On-box system cron (recommended) or GitHub Actions (fallback) — see Step 5 |
| Hosting | **Vercel** |

**Stub mode:** Without credentials, every layer falls back to canned data so the UI is interactive. As you fill env vars, each subsystem flips to real behavior.

## Step 1 — Clerk (auth)

1. Sign up at [clerk.com](https://clerk.com) → create an application.
2. **API Keys** → copy the publishable key + secret key.
3. **Paths** (User & authentication → Settings → Paths): leave defaults — `/sign-in`, `/sign-up`. Sociafy already exposes those routes.
4. (Optional) **Social Connections**: enable Google, GitHub, etc. — Clerk handles the OAuth dance.
5. **Authorized URLs**: add your Vercel domain + `http://localhost:3000`.

Set:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL=/onboarding
```

## Step 2 — Postgres

Anywhere — Supabase, Neon, Railway, your own. You only need a connection string.

1. Create a Postgres database.
2. Run `drizzle/0000_init.sql` in the SQL editor (idempotent — safe to re-run).
3. Set `DATABASE_URL=postgresql://...`. Use a **pooler URL** for serverless — e.g. Supabase's transaction pooler (`...pooler.supabase.com:6543`) or Neon's pooled connection string.

> Tip: instead of pasting the SQL, run `npx drizzle-kit push` once `DATABASE_URL` is set.

## Step 3 — Cloudflare R2 (media uploads)

1. Cloudflare dashboard → **R2** → Create bucket. Call it `sociafy-media` (or whatever).
2. **Settings → Public access**: enable "Allow Access" via the public r2.dev URL, or attach a custom domain. Copy the public base URL.
3. **Manage R2 API Tokens** → Create API Token → permissions: **Object Read & Write** for that bucket. Copy the access key + secret.
4. Bucket → Settings → CORS policy: paste:
   ```json
   [
     {
       "AllowedOrigins": ["https://your-domain.com", "http://localhost:3000"],
       "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   (Add your Vercel domain.)

Set:
```
R2_ACCOUNT_ID=...                          # Found at dashboard top-right
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=sociafy-media
NEXT_PUBLIC_R2_PUBLIC_URL_BASE=https://pub-<hash>.r2.dev
```

## Step 4 — Anthropic

[console.anthropic.com](https://console.anthropic.com) → API Keys.
```
ANTHROPIC_API_KEY=sk-ant-...
```

## Step 5 — Scheduled jobs

```
CRON_SECRET=<32+ char random string>
INTERNAL_API_SECRET=<another random string>
```

`CRON_SECRET` gates `/api/cron/*` via `checkCronAuth` (`lib/api.ts`) — constant-time,
and it refuses to run at all when the secret is missing or under 16 chars, so the
routes fail closed. Never reuse the value from `.env.example`.

The jobs themselves: `publish` every 5 min, `finalize-video-jobs` every 5 min,
`shield-monitor` every 15 min, `trends` hourly, `agent` every 2 h,
`refresh-tokens` every 6 h (daily at 03:00 UTC on Actions).

> `finalize-video-jobs` is not optional. It is the only thing that fails a stuck
> media job and **refunds the customer's credits**. If it never runs, those
> credits are held forever.

### Pick ONE mechanism

There are two, and **running both double-fires every job**. That is safe —
`runPublish` claims rows with an atomic `UPDATE … RETURNING`, and the media
sweeper's finalisers claim conditionally, so nothing double-posts or
double-refunds — but it is wasted work and it makes logs impossible to read.
Choose one.

**A. On-box system cron — recommended for this deployment.**

This app runs on a plain EC2 box (`/home/ubuntu/sociafy`, user `ubuntu`), so cron is
right there:

```bash
sudo bash scripts/install-cron.sh --dir /home/ubuntu/sociafy --user ubuntu
# preview first with --dry-run
```

It renders `etc/cron.d/sociafy` into `/etc/cron.d/sociafy`. Each entry runs
`node scripts/cron-run.mjs <task>`, which imports `lib/cron/*.ts` directly — **no
HTTP, and no `CRON_SECRET` needed by the cron user**. That means jobs still run
when the web process is down or wedged, which is exactly when a stuck job needs
sweeping. Logs land in `/var/log/sociafy/cron-<task>.log`.

Re-run `install-cron.sh` after any deploy that changes the schedule
(`scripts/deploy.sh` tells you when that happened).

To disable it: `sudo rm /etc/cron.d/sociafy && sudo systemctl reload cron`.

**B. GitHub Actions (`.github/workflows/scheduled-jobs.yml`) — the fallback.**

Use this only where you cannot install cron (Vercel, Railway, a managed host with
no shell). It just makes HTTPS calls to `/api/cron/*`, so it is host- and
plan-agnostic. Configure in repo **Settings → Secrets and variables → Actions**:

| | Name | Value |
|---|---|---|
| Secret | `CRON_SECRET` | **required** — must equal the deployed environment's value, or every call 401s |
| Variable | `APP_URL` | optional, defaults to `https://sociafy.app` |

Run one on demand from the Actions tab via **Run workflow** to verify setup.

Two failure modes to know: GitHub's scheduler is best-effort and can lag several
minutes under load (every job is idempotent, so a late run is safe), and
**scheduled workflows are disabled after 60 days of repository inactivity** —
check that first if posts silently stop publishing.

To disable it: repo **Actions → Scheduled jobs → ⋯ → Disable workflow**. Don't
delete the file — it is the fallback if you ever move off the box.

**Not `vercel.json`.** It deliberately has no `crons` block: on the Hobby plan any
sub-daily expression fails at *deploy* time (one `*/5 * * * *` blocks the whole
deployment), and `sociafy.app` answers from Cloudflare with no `x-vercel-id`
header, so `vercel.json` crons would be silently inert anyway. If you move to
Vercel Pro and add the block back, disable the other two in the same commit.

## Step 6 — Social platforms

Each adapter activates when its env vars are set. Until then, "Connect" creates a stub account so the rest of the UI is usable.

Set redirect URI for each platform to:
```
https://<your-app>.vercel.app/api/oauth/<platform>/callback
```
Replace `<platform>` with: `x`, `linkedin`, `instagram`, `facebook`, `tiktok`, `youtube`.

### Meta (Instagram + Facebook) — for the demo

1. [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App → Type **Business**.
2. Add products: **Facebook Login for Business** + **Instagram Graph API**.
3. **Settings → Basic**: copy App ID + App Secret → `META_APP_ID`, `META_APP_SECRET`.
4. **Facebook Login → Settings → Valid OAuth Redirect URIs**:
   - `https://<your-app>.vercel.app/api/oauth/facebook/callback`
   - `https://<your-app>.vercel.app/api/oauth/instagram/callback`
5. **App Roles → Roles → Add People**: yourself, co-founder, investor as **Administrators** or **Testers**. They each accept from their FB account. Test users skip App Review.
6. The account that posts needs:
   - A Facebook **Page** (create one in 2 min if needed).
   - An **Instagram Business or Creator** account (IG → Settings → Account type).
   - **Linked**: FB Page → Settings → Linked Accounts → Instagram.
7. Permissions our adapter requests (all available to test users with no review):
   `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `public_profile`.

**App Review** is only required for non-test users. Don't bother for the demo.

### X (Twitter)
[developer.x.com](https://developer.x.com) → Project → User authentication settings → OAuth 2.0 → confidential client.
Scopes: `tweet.read tweet.write users.read offline.access`.
Set: `X_CLIENT_ID`, `X_CLIENT_SECRET`.

### LinkedIn
[developer.linkedin.com](https://developer.linkedin.com) → Create app → Products: **Sign In with LinkedIn (OIDC)** + **Share on LinkedIn**.
Scopes: `openid profile w_member_social`.
Set: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.

### TikTok
[developers.tiktok.com](https://developers.tiktok.com) → Apps → enable **Login Kit** + **Content Posting API**.
Scopes: `user.info.basic video.upload video.publish`.
Posting requires a publicly hosted video URL (PULL_FROM_URL). Upload your video to R2 first, then schedule.
Set: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`.

### Google (YouTube)
[console.cloud.google.com](https://console.cloud.google.com) → enable **YouTube Data API v3** → OAuth client (Web).
Scopes: `https://www.googleapis.com/auth/youtube.upload` + `youtube.readonly`.
Current adapter does OAuth + channel discovery. Resumable video upload is the next step.
Set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## Step 7 — Run

```bash
cp .env.example .env.local
# fill values
npm install
npm run dev
```

For production **on the EC2 box** — deployment is manual, and a commit is not
live until you run this:

```bash
ssh <box> && bash /home/ubuntu/sociafy/scripts/deploy.sh    # --dry-run to preview
```

It pulls, `npm ci`, builds, restarts the web process and verifies `/api/health`.
A failed build stops before the restart, so the running site stays up.

For Vercel instead: push to GitHub, import in Vercel, paste env vars, deploy.

## Architecture notes

- **Clerk middleware** lives in `proxy.ts` (Next.js 16 renamed `middleware` → `proxy`). It protects `/dashboard`, `/onboarding`, and gates the API surface.
- **DB security:** every API route filters by `auth().userId`. No row-level security at the DB layer — the API is the only access path. If you want defense in depth later, you can layer Postgres RLS using Clerk JWT claims.
- **Profile sync:** on the first authenticated API call, `lib/api.ts/withUser` upserts a row into `profiles` with the user's name, email, and avatar from Clerk. No webhooks needed for MVP.
- **Storage:** `lib/storage/r2.ts` uses the AWS S3 SDK pointed at R2's S3-compatible endpoint. Server-side multipart upload at `/api/media/upload` (50MB cap). `media_assets` row holds the R2 object key + the public URL.
- **Platform registry:** `lib/platforms/registry.ts` maps `Platform` → adapter. Adding a platform = drop a new adapter file + register.
- **Cron:** two entry points per job, one implementation. `lib/cron/*.ts` holds the logic; `/api/cron/*` wraps it in `Authorization: Bearer $CRON_SECRET`, and `scripts/cron-run.mjs <task>` calls it directly for on-box cron. The publish job picks up `scheduled_posts WHERE status='pending' AND scheduled_at <= now()` (limit 50/run, idempotent via attempts counter). `lib/cron/finalizeJobs.ts` sweeps stale `video_jobs` and stale async image `gen_jobs`, failing and refunding what nothing else will close out.
- **Agent:** `/api/cron/agent` per-user — consumes new trends, calls Claude (Sonnet) to draft, schedules posts that score ≥ `auto_publish_threshold`, holds the rest as drafts.

## Demo smoke test (after credentials are in)

1. `npm run dev`, visit `/sign-up`, create a Clerk account.
2. Land in `/onboarding`. Click each platform — real OAuth dialogs fire (or stubs if missing keys).
3. Pick niches, pick a style, hit Continue → "Enter Sociafy."
4. Land in `/dashboard`. Click Compose → write a prompt → Generate. Real Claude variants populate.
5. Click "Upload" in Media — pick an image. It lands in R2 and the public URL appears in the draft.
6. Click "Schedule (+30m)." Check the Calendar → your post appears in the right slot.
7. Trigger the cron manually:
   ```bash
   curl -X POST https://<your-app>.vercel.app/api/cron/publish \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
8. Check the actual platform — your post is live.

## What's intentionally not built

- **Voice profile / TTS** — out of scope for the first cut. `voice_template` is just a tone hint.
- **YouTube resumable upload** — OAuth + channel discovery only.
- **Analytics ingestion** — `engagement` jsonb field exists; the fetcher cron is the next job.
- **Notifications** — activity log feeds the UI; push/email is not built.
