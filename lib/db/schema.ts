import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  boolean,
  jsonb,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

export const PLATFORMS = ['x', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const NICHES = [
  'saas',
  'creator-economy',
  'marketing',
  'ai',
  'design',
  'devtools',
  'fintech',
  'media',
  'community',
] as const;
export type Niche = (typeof NICHES)[number];

export const VOICE_TEMPLATES = ['me', 'punchy', 'thoughtful', 'data-led'] as const;
export type VoiceTemplate = (typeof VOICE_TEMPLATES)[number];

// =====================================================
// profiles — keyed by Clerk userId (text, e.g. "user_2abc...")
// =====================================================
export const TIERS = ['starter', 'pro', 'business'] as const;
export type Tier = (typeof TIERS)[number];

/** Per-tier monthly credit allocation. The source of truth for what each
 *  paying tier gets when their cycle rolls over. Numbers come straight from
 *  docs/pricing.md §4. */
export const TIER_CREDITS: Record<Tier, number> = {
  starter: 2_000,
  pro: 6_000,
  business: 25_000,
};

export const profiles = pgTable('profiles', {
  id: text('id').primaryKey(), // Clerk userId
  displayName: text('display_name'),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  email: text('email'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  // Billing — tier drives the monthly credit allocation; cycleStart is the
  // anchor for "this month's" budget. Stripe wiring will reset cycleStart and
  // insert a monthly_grant ledger row each renewal. Until Stripe ships, every
  // new profile gets a signup grant of TIER_CREDITS[tier] in the ledger so
  // the system is usable.
  tier: text('tier').notNull().$type<Tier>().default('starter'),
  creditCycleStart: timestamp('credit_cycle_start', { withTimezone: true }).defaultNow().notNull(),
  // Stripe linkage. Null until the user runs a Checkout once. We never read
  // tier directly from Stripe at request time — webhooks mirror Stripe's
  // truth into these columns + the credit_ledger, and reads happen locally.
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionStatus: text('subscription_status'), // 'active' | 'past_due' | 'canceled' | 'incomplete' | null
  subscriptionCurrentPeriodEnd: timestamp('subscription_current_period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// =====================================================
// credit_ledger — append-only signed-credit ledger.
//
// Every billable event is a row. Sign convention:
//   credits > 0 → user gains credits (signup_bonus, monthly_grant, topup, refund)
//   credits < 0 → user spends credits (charge)
//
// Balance for a user = SUM(credits) WHERE user_id = ?.
//
// No row is ever mutated — refunds for failed generations are NEW rows with
// the opposite sign. This keeps the ledger auditable and resists races.
// =====================================================
export const CREDIT_LEDGER_KINDS = [
  'charge',          // user-initiated billable event (negative credits)
  'refund',          // failed generation reversal (positive credits)
  'signup_bonus',    // one-time grant on profile creation
  'monthly_grant',   // cycle rollover allocation (Stripe-driven later)
  'topup',           // one-off paid credit purchase
  'admin_grant',     // manual adjustment by an admin
] as const;
export type CreditLedgerKind = (typeof CREDIT_LEDGER_KINDS)[number];

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull().$type<CreditLedgerKind>(),
    /** For 'charge' rows, the action key from lib/credits/pricing.ts (e.g.
     *  'image_medium_1024'). Null for grants / refunds where the parent
     *  charge row carries the action. */
    action: text('action'),
    credits: integer('credits').notNull(),
    /** Per-event context: draftId, assetId, jobId, tool-call counts, etc. */
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
    /** When this row refunds an earlier row, points back so the UI can group. */
    relatedLedgerId: uuid('related_ledger_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('credit_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('credit_ledger_user_kind_idx').on(t.userId, t.kind),
  ],
);

// =====================================================
// connected_accounts — one row per (user, platform)
// =====================================================
export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    platform: text('platform').notNull().$type<Platform>(),
    platformUserId: text('platform_user_id').notNull(),
    handle: text('handle'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
    isStub: boolean('is_stub').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('connected_accounts_user_idx').on(t.userId),
    index('connected_accounts_user_platform_idx').on(t.userId, t.platform),
  ],
);

// =====================================================
// drafts
// =====================================================
export type DraftVariant = {
  label: string;
  text: string;
  score?: number;
  rationale?: string;
};

export type DraftMedia = {
  id: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
};

export type DraftStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    title: text('title'),
    prompt: text('prompt'),
    body: text('body').notNull().default(''),
    variants: jsonb('variants').$type<DraftVariant[]>().default([]),
    selectedVariantLabel: text('selected_variant_label'),
    media: jsonb('media').$type<DraftMedia[]>().default([]),
    targetPlatforms: jsonb('target_platforms').$type<Platform[]>().notNull().default([]),
    perPlatformText: jsonb('per_platform_text').$type<Partial<Record<Platform, string>>>().default({}),
    preset: text('preset'),
    status: text('status').notNull().$type<DraftStatus>().default('draft'),
    source: text('source').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('drafts_user_idx').on(t.userId),
    index('drafts_status_idx').on(t.status),
  ],
);

// =====================================================
// scheduled_posts
// =====================================================
export type ScheduledStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'canceled';

export const scheduledPosts = pgTable(
  'scheduled_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().$type<Platform>(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().$type<ScheduledStatus>().default('pending'),
    text: text('text').notNull(),
    media: jsonb('media').$type<DraftMedia[]>().default([]),
    platformPostId: text('platform_post_id'),
    platformPostUrl: text('platform_post_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    engagement: jsonb('engagement').$type<{
      likes?: number;
      replies?: number;
      reposts?: number;
      views?: number;
      lastSyncedAt?: string;
    }>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('scheduled_user_idx').on(t.userId),
    index('scheduled_status_due_idx').on(t.status, t.scheduledAt),
    index('scheduled_draft_idx').on(t.draftId),
  ],
);

// =====================================================
// agent_settings
// =====================================================
export type QuietHours = { start: string; end: string };

/** Weekly post quota for each content kind. Autopilot uses these to decide
 *  what to draft next: when text quota is exhausted but image isn't, it
 *  routes the next trend into image-gen instead. Zero means "never". */
export type PostsPerWeekByType = { text: number; image: number; video: number };

export const agentSettings = pgTable('agent_settings', {
  userId: text('user_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  instructions: text('instructions').notNull().default(''),
  cadencePerWeek: integer('cadence_per_week').notNull().default(4),
  // 101 = "drafts only" (unreachable, since AI scores top out at 100). Users
  // who want auto-publish opt in during onboarding's Plan step and pick a
  // threshold ≤ 100. The drafts-only default is the safer behavior: agent
  // fills your inbox, you approve each post.
  autoPublishThreshold: integer('auto_publish_threshold').notNull().default(101),
  quietHours: jsonb('quiet_hours').$type<QuietHours>().default({ start: '22:00', end: '07:00' }),
  brandSafetyStrict: boolean('brand_safety_strict').notNull().default(true),
  niches: jsonb('niches').$type<Niche[]>().notNull().default([]),
  voiceTemplate: text('voice_template').$type<VoiceTemplate>().default('me'),
  trendSources: jsonb('trend_sources').$type<string[]>().default([]),
  // Brand profile — used to inject "who you are" context into every AI call
  // (image rewriter, video rewriter, caption variants). Without this, the
  // model only sees the user's loose prompt and the skill file for the
  // target model; output is generic. With it, output is on-brand.
  companyName: text('company_name'),
  brandBio: text('brand_bio'),
  website: text('website'),
  // Autopilot permission matrix — the user explicitly chooses which
  // platforms autopilot may post to and how many posts/week per platform.
  // Empty array on enabledPlatforms means "all connected platforms" (legacy
  // behavior); listing specific platforms restricts to those.
  enabledPlatforms: jsonb('enabled_platforms').$type<Platform[]>().notNull().default([]),
  postsPerWeekByPlatform: jsonb('posts_per_week_by_platform').$type<Partial<Record<Platform, number>>>().notNull().default({}),
  postsPerWeekByContentType: jsonb('posts_per_week_by_content_type').$type<PostsPerWeekByType>().notNull().default({ text: 4, image: 0, video: 0 }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// =====================================================
// activity_log
// =====================================================
export type ActivityKind =
  | 'platform_connected'
  | 'platform_disconnected'
  | 'draft_created'
  | 'draft_scheduled'
  | 'manual_publish'
  | 'auto_publish'
  | 'publish_failed'
  | 'agent_drafted'
  | 'agent_held'
  | 'agent_skipped'
  | 'trend_spotted'
  | 'agent_enabled'
  | 'agent_disabled'
  | 'onboarded'
  | 'webhook_event';

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull().$type<ActivityKind>(),
    title: text('title').notNull(),
    body: text('body'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('activity_user_created_idx').on(t.userId, t.createdAt),
    index('activity_kind_idx').on(t.kind),
  ],
);

// =====================================================
// trends
// =====================================================
export type TrendStatus = 'new' | 'used' | 'dismissed';

export const trends = pgTable(
  'trends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    niche: text('niche').notNull().$type<Niche>(),
    title: text('title').notNull(),
    summary: text('summary'),
    source: text('source'),
    sourceUrl: text('source_url'),
    volume: integer('volume'),
    delta: numeric('delta'),
    score: integer('score').notNull().default(0),
    status: text('status').notNull().$type<TrendStatus>().default('new'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
    usedInDraftId: uuid('used_in_draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('trends_user_status_idx').on(t.userId, t.status),
    index('trends_niche_idx').on(t.niche),
  ],
);

// =====================================================
// media_assets — uploads to R2
// =====================================================
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    storageKey: text('storage_key').notNull(),
    publicUrl: text('public_url').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes'),
    width: integer('width'),
    height: integer('height'),
    durationS: numeric('duration_s'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('media_user_idx').on(t.userId)],
);

// =====================================================
// video_jobs — async video generation tasks (PiAPI Seedance)
//
// Video gen is async: we submit a task to PiAPI, get back a task_id,
// and the client polls until the model finishes (30–120s). We store the
// task here keyed by user so the polling endpoint can authorize, hold
// the params we'll need to label the finished mediaAsset, and avoid
// double-finalizing on race conditions.
// =====================================================
export const videoJobs = pgTable(
  'video_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    provider: text('provider').notNull(),           // e.g. 'piapi-seedance-2'
    providerTaskId: text('provider_task_id').notNull(),
    status: text('status').notNull().default('pending'), // pending | completed | failed
    prompt: text('prompt').notNull(),
    rewrittenPrompt: text('rewritten_prompt'),
    durationSec: integer('duration_sec').notNull(),
    aspect: text('aspect').notNull(),
    quality: text('quality').notNull(),
    genMode: text('gen_mode').notNull(),
    mediaAssetId: uuid('media_asset_id'),
    error: text('error'),
    /** credit_ledger.id of the charge row for this job. Lets the polling
     *  endpoint refund credits if PiAPI returns failed. Null for legacy
     *  rows from before the credit system shipped. */
    creditLedgerId: uuid('credit_ledger_id'),
    creditsCharged: integer('credits_charged'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('video_jobs_user_idx').on(t.userId),
    index('video_jobs_task_idx').on(t.providerTaskId),
  ],
);
