# Sociafy — setup

This is the playbook for taking the app from "deployed scaffolding" to "fully wired with real OAuth + Claude + cron." Read it top to bottom; the order matters.

## What's already built

| Layer | What you get |
|---|---|
| Frontend | `/` landing, `/sign-in`, `/sign-up`, `/onboarding`, `/dashboard` SPA (compose / autopilot / calendar / dashboard) |
| Auth | Supabase email + OAuth (Google, GitHub). Session refresh in `proxy.ts`. |
| DB | Drizzle schema in `lib/db/schema.ts`. Initial SQL in `drizzle/0000_init.sql`. RLS-enabled. |
| API | `/api/accounts`, `/api/drafts`, `/api/schedule`, `/api/agent/settings`, `/api/activity`, `/api/trends`, `/api/compose/variants`, `/api/oauth/[platform]/{start,callback}`, `/api/cron/{publish,agent,trends}` |
| Platform adapters | X, LinkedIn, Instagram, Facebook, TikTok, YouTube — real OAuth + posting code paths. Stub fallback when credentials are missing. |
| Cron | Vercel Cron config in `vercel.json`. Publish every 5 min, agent every 2 hr, trends hourly. |

**Stub mode:** Without credentials, every layer falls back to safe stubs so the UI is interactive. As you add env vars, each subsystem flips to real behavior.

---

## Step 1 — Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → API**: copy `URL`, `anon public`, `service_role`.
3. **Project Settings → Database → Connection string → URI**: copy the **Transaction pooler** URL (pooler.supabase.com). You'll use this as `DATABASE_URL`.
4. **SQL Editor → New query**: paste `drizzle/0000_init.sql` and run. Re-runnable; it's idempotent.
5. **Authentication → URL Configuration**: set `Site URL` = your deployed URL, add `https://<your-app>.vercel.app/auth/callback` to allowed redirects (and `http://localhost:3000/auth/callback` for local dev).
6. **Authentication → Providers**: enable Google + GitHub if you want OAuth sign-in (optional).
7. **Storage → New bucket**: name it `media`, public. (Used later when media uploads land.)

Set in `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-...pooler.supabase.com:6543/postgres
```

> Tip: instead of pasting the SQL, you can run `npx drizzle-kit push` once `DATABASE_URL` is set.

## Step 2 — Anthropic

1. Get a key at [console.anthropic.com](https://console.anthropic.com).
2. `ANTHROPIC_API_KEY=sk-ant-...`

That's it — compose variants and the autopilot agent will start using Claude.

## Step 3 — Cron secret

Generate a random string and set:

```
CRON_SECRET=<32+ char random string>
INTERNAL_API_SECRET=<another random string>
```

`CRON_SECRET` gates `/api/cron/*` routes. Vercel Cron sends it automatically as `Authorization: Bearer $CRON_SECRET` if you configure the env var on Vercel.

If you're on Vercel **Hobby**, the per-minute crons in `vercel.json` won't fire. Use [cron-job.org](https://cron-job.org) (free) and point it at:

```
POST https://<your-app>.vercel.app/api/cron/publish
Authorization: Bearer <CRON_SECRET>
```

…every 5 minutes. Same for `/api/cron/agent` (every 2hr) and `/api/cron/trends` (hourly).

## Step 4 — Social platforms

Each adapter activates when its env vars are set. Until then, "Connect" creates a stub account so the rest of the UI is usable.

Set the redirect URI for each platform to:

```
https://<your-app>.vercel.app/api/oauth/<platform>/callback
```

Replace `<platform>` with: `x`, `linkedin`, `instagram`, `facebook`, `tiktok`, `youtube`.

### X (Twitter)
- [developer.x.com](https://developer.x.com) → Project → User authentication settings → OAuth 2.0 → confidential client
- Scopes: `tweet.read tweet.write users.read offline.access`
- Set: `X_CLIENT_ID`, `X_CLIENT_SECRET`

### LinkedIn
- [developer.linkedin.com](https://developer.linkedin.com) → My apps → Create app → Products: **Sign In with LinkedIn (OIDC)** + **Share on LinkedIn** (or **Marketing Developer Platform** for page posts)
- Scopes: `openid profile w_member_social`
- Set: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`

### Meta (Instagram + Facebook)
- [developers.facebook.com](https://developers.facebook.com) → Create app → **Business** type
- Add products: **Facebook Login**, **Instagram Graph API**
- Permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`
- The user you're testing with must have a Facebook Page; for Instagram, the IG account must be **Business** linked to that page.
- Set: `META_APP_ID`, `META_APP_SECRET`

### TikTok
- [developers.tiktok.com](https://developers.tiktok.com) → Apps → Add app → enable **Login Kit** + **Content Posting API**
- Scopes: `user.info.basic video.upload video.publish`
- TikTok requires a publicly hosted video URL for posts. For the MVP, the adapter uses `PULL_FROM_URL`; the video must be reachable from TikTok's servers.
- Set: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`

### Google (YouTube)
- [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Enable: **YouTube Data API v3**
- Credentials → OAuth 2.0 client (Web)
- Scopes: `https://www.googleapis.com/auth/youtube.upload` + `youtube.readonly`
- Posting requires resumable upload — the current adapter performs OAuth + channel discovery only. A worker that uploads from `media_assets` is the next step.
- Set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Step 5 — Run

```bash
cp .env.example .env.local
# fill values
npm install
npm run dev
```

Open http://localhost:3000.

For production: push to GitHub, import in Vercel, paste the env vars, deploy.

## Architecture notes

- **Schema:** Drizzle in `lib/db/schema.ts`. SQL bootstrap in `drizzle/0000_init.sql` (idempotent, RLS on every table).
- **Server clients:** `lib/supabase/server.ts` for route handlers (cookie-aware), `lib/supabase/admin.ts` for service-role calls, `lib/supabase/client.ts` for the browser.
- **Auth gates:** `proxy.ts` redirects `/dashboard` and `/onboarding` to `/sign-in` when no session. (Next.js 16 renamed `middleware` → `proxy`.)
- **Platform registry:** `lib/platforms/registry.ts` maps `Platform` → adapter. Adapters expose `buildAuthorizeUrl`, `exchangeCode`, `publishText`. Adding a platform = drop a new adapter file + register.
- **Stub mode:** every adapter returns canned data when its credentials are absent. The `is_stub` flag on `connected_accounts` tracks fake connections so you can see them in the UI.
- **Cron:** `Authorization: Bearer $CRON_SECRET`. The `publish` job picks up `scheduled_posts WHERE status='pending' AND scheduled_at <= now()` (limit 50/run, idempotent via attempts counter).
- **Agent:** `/api/cron/agent` per-user — consumes new trends, calls Claude (Sonnet) to draft, schedules posts that score ≥ `auto_publish_threshold`, holds the rest as drafts.
- **Trends:** `/api/cron/trends` ingests RSS from Hacker News + niche subreddits, persists per-user with a random base score; you can replace the source list in `lib/trends/sources.ts`.

## What's intentionally *not* built

- **Voice profile / TTS:** out of scope for this first cut. The `voice_template` field is just a tone hint; it doesn't analyze past posts.
- **Media uploads to Supabase Storage:** the schema and `media_assets` table are ready; the upload flow + per-platform variant generation is the next thing to wire.
- **Analytics ingestion:** post engagement is captured to `scheduled_posts.engagement` jsonb but no fetcher cron is wired yet (per-platform metric APIs are a future job).
- **Notifications:** the activity log feeds the UI; push/email is not built.

## Quick smoke test (after credentials are in)

1. `npm run dev`, visit `/sign-up`, create an account.
2. Land in `/onboarding`. Click each platform — real OAuth dialogs should fire.
3. Pick niches, pick a style, hit Continue → "Enter Sociafy."
4. Land in `/dashboard`. Click Compose → write a prompt → Generate. Real Claude variants should populate.
5. Click "Schedule (+30m)." Check the Calendar → your post should appear.
6. Trigger the cron manually:
   ```
   curl -X POST https://<your-app>.vercel.app/api/cron/publish -H "Authorization: Bearer $CRON_SECRET"
   ```
7. Check the actual platform — your post should be live.
