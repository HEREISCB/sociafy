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
export const profiles = pgTable('profiles', {
  id: text('id').primaryKey(), // Clerk userId
  displayName: text('display_name'),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  email: text('email'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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

export const agentSettings = pgTable('agent_settings', {
  userId: text('user_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  instructions: text('instructions').notNull().default(''),
  cadencePerWeek: integer('cadence_per_week').notNull().default(4),
  autoPublishThreshold: integer('auto_publish_threshold').notNull().default(90),
  quietHours: jsonb('quiet_hours').$type<QuietHours>().default({ start: '22:00', end: '07:00' }),
  brandSafetyStrict: boolean('brand_safety_strict').notNull().default(true),
  niches: jsonb('niches').$type<Niche[]>().notNull().default([]),
  voiceTemplate: text('voice_template').$type<VoiceTemplate>().default('me'),
  trendSources: jsonb('trend_sources').$type<string[]>().default([]),
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
  | 'onboarded';

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
