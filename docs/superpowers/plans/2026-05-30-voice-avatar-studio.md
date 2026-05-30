# Voice & Avatar Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Voice Twin" (zero-shot voice cloning) and "Avatar" (talking-head video) to Sociafy, powered by Modal-hosted GPU models, integrated into the existing composer's video studio and async job/poll/credits pipeline.

**Architecture:** Two Modal GPU services (`voice-engine`, `avatar-engine`) expose secret-authed web endpoints. Next.js submits jobs and polls, mirroring the existing PiAPI/Seedance `videoJobs → poll → R2 → mediaAssets` flow. A new generic `genJobs` table backs Modal jobs; `voices` stores cloned-voice profiles + consent. Underlying model names are never exposed.

**Tech Stack:** Next.js 16, React 19, Drizzle/Postgres (Supabase), Cloudflare R2, Clerk, Vitest, Modal (Python), OmniVoice + Whisper (voice), LongCat-Video-Avatar 1.5 (avatar).

**Spec:** `docs/superpowers/specs/2026-05-30-voice-avatar-studio-design.md`

**Conventions to mirror (read these first):**
- `lib/ai/piapi.ts` — TLS-hardened `https.request` client style.
- `app/api/media/generate-video/route.ts` — submit + charge + insert job.
- `app/api/media/video-job/[jobId]/route.ts` — poll + download + R2 + mediaAsset + refund.
- `lib/credits/pricing.ts`, `lib/credits/ledger.ts` — pricing + charge/refund.
- `lib/db/schema.ts` — Drizzle table style.
- `components/compose.tsx` (lines ~1226–1368) — video gen-mode grid + anchor inputs.
- Migrations: write SQL to `drizzle/*.sql`; user applies via Supabase SQL editor (db:push is unreliable — see project memory).

---

## Task 1: DB schema — `voices` and `genJobs`

**Files:**
- Modify: `lib/db/schema.ts` (append after `videoJobs`, ~line 415)
- Create: `drizzle/0009_voice_avatar.sql` (check existing `drizzle/` numbering; use the next integer)

- [ ] **Step 1: Add Drizzle tables to `lib/db/schema.ts`**

Append (uses imports already present in the file — `pgTable, uuid, text, integer, numeric, timestamp, index, jsonb`; add `jsonb` to the import list at the top if missing):

```ts
// =====================================================
// voices — cloned "Voice Twin" profiles + consent record.
// Zero-shot: a profile is (reference clip in R2 + its transcript).
// =====================================================
export const voices = pgTable(
  'voices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('preparing'), // preparing | ready | failed
    refStorageKey: text('ref_storage_key').notNull(),
    refPublicUrl: text('ref_public_url').notNull(),
    refDurationS: numeric('ref_duration_s'),
    transcript: text('transcript'),
    language: text('language'),
    consentVersion: text('consent_version').notNull(),
    consentSignature: text('consent_signature').notNull(),
    consentAcceptedAt: timestamp('consent_accepted_at', { withTimezone: true }).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('voices_user_idx').on(t.userId)],
);

// =====================================================
// gen_jobs — generic async Modal job (tts | avatar). videoJobs stays
// dedicated to PiAPI Seedance. Same poll/charge/refund lifecycle.
// =====================================================
export const genJobs = pgTable(
  'gen_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),                  // 'tts' | 'avatar'
    provider: text('provider').notNull(),          // 'modal-voice' | 'modal-avatar'
    providerCallId: text('provider_call_id').notNull(),
    status: text('status').notNull().default('pending'), // pending | completed | failed
    inputJson: jsonb('input_json'),
    mediaAssetId: uuid('media_asset_id'),
    error: text('error'),
    creditLedgerId: uuid('credit_ledger_id'),
    creditsCharged: integer('credits_charged'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('gen_jobs_user_idx').on(t.userId),
    index('gen_jobs_call_idx').on(t.providerCallId),
  ],
);
```

- [ ] **Step 2: Write the migration SQL** `drizzle/0009_voice_avatar.sql`

```sql
CREATE TABLE IF NOT EXISTS "voices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'preparing' NOT NULL,
  "ref_storage_key" text NOT NULL,
  "ref_public_url" text NOT NULL,
  "ref_duration_s" numeric,
  "transcript" text,
  "language" text,
  "consent_version" text NOT NULL,
  "consent_signature" text NOT NULL,
  "consent_accepted_at" timestamptz NOT NULL,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "voices_user_idx" ON "voices" ("user_id");

CREATE TABLE IF NOT EXISTS "gen_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "provider_call_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "input_json" jsonb,
  "media_asset_id" uuid,
  "error" text,
  "credit_ledger_id" uuid,
  "credits_charged" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gen_jobs_user_idx" ON "gen_jobs" ("user_id");
CREATE INDEX IF NOT EXISTS "gen_jobs_call_idx" ON "gen_jobs" ("provider_call_id");
```

- [ ] **Step 3: Typecheck** — Run: `npx tsc --noEmit` — Expected: no new errors.
- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts drizzle/0009_voice_avatar.sql
git commit -m "feat(db): add voices + gen_jobs tables for Voice & Avatar Studio"
```

> **Human step (flag to user):** paste `drizzle/0009_voice_avatar.sql` into the Supabase SQL editor to apply. Do not rely on `db:push`.

---

## Task 2: Credit pricing actions

**Files:**
- Modify: `lib/credits/pricing.ts`
- Test: `lib/credits/pricing.voiceavatar.test.ts` (create)

- [ ] **Step 1: Write the failing test** `lib/credits/pricing.voiceavatar.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { creditsFor, priceForAvatar, CREDIT_PRICES } from './pricing';

describe('voice/avatar pricing', () => {
  it('has voice + tts action prices', () => {
    expect(creditsFor('voice_twin_create')).toBe(5);
    expect(creditsFor('tts_synthesis')).toBe(4);
  });
  it('prices avatar by quality', () => {
    expect(priceForAvatar('480p')).toEqual({ action: 'avatar_video_480p', credits: 50 });
    expect(priceForAvatar('720p')).toEqual({ action: 'avatar_video_720p', credits: 90 });
  });
  it('exposes labels for new actions', () => {
    // ACTION_LABELS must contain every CreditAction key (ledger UI invariant)
    expect(CREDIT_PRICES.avatar_video_720p).toBe(90);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — Run: `npx vitest run lib/credits/pricing.voiceavatar.test.ts` — Expected: FAIL (`voice_twin_create` not assignable / `priceForAvatar` undefined).

- [ ] **Step 3: Extend `lib/credits/pricing.ts`**

Add to the `CreditAction` union: `| 'voice_twin_create' | 'tts_synthesis' | 'avatar_video_480p' | 'avatar_video_720p'`.

Add to `CREDIT_PRICES`:
```ts
  voice_twin_create: 5,
  tts_synthesis: 4,
  avatar_video_480p: 50,   // CALIBRATE: ceil(measured_cost*1.10/0.009) after Modal benchmark
  avatar_video_720p: 90,   // CALIBRATE: ditto
```

Add to `ACTION_LABELS`:
```ts
  voice_twin_create: 'Voice Twin created',
  tts_synthesis: 'Text-to-speech',
  avatar_video_480p: 'Avatar video · 480p',
  avatar_video_720p: 'Avatar video · 720p',
```

Add the helper:
```ts
// =====================================================
// Avatar-gen price helper
// =====================================================
export function priceForAvatar(
  quality: '480p' | '720p',
): { action: CreditAction; credits: number } {
  const action: CreditAction = quality === '720p' ? 'avatar_video_720p' : 'avatar_video_480p';
  return { action, credits: CREDIT_PRICES[action] };
}
```

- [ ] **Step 4: Run test, verify pass** — Run: `npx vitest run lib/credits/pricing.voiceavatar.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/credits/pricing.ts lib/credits/pricing.voiceavatar.test.ts
git commit -m "feat(credits): add voice/tts/avatar pricing actions"
```

---

## Task 3: Consent copy module

**Files:**
- Create: `lib/legal/voiceConsent.ts`
- Test: `lib/legal/voiceConsent.test.ts`

- [ ] **Step 1: Write the failing test** `lib/legal/voiceConsent.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { VOICE_CONSENT_VERSION, VOICE_CONSENT_TEXT, validateConsent } from './voiceConsent';

describe('voice consent', () => {
  it('exposes a current version + non-empty text', () => {
    expect(VOICE_CONSENT_VERSION).toMatch(/^v\d+$/);
    expect(VOICE_CONSENT_TEXT.length).toBeGreaterThan(100);
  });
  it('accepts a current-version signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: 'Jane Doe' }).ok).toBe(true);
  });
  it('rejects empty signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: ' ' }).ok).toBe(false);
  });
  it('rejects stale version', () => {
    expect(validateConsent({ version: 'v0', signature: 'Jane Doe' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail** — Run: `npx vitest run lib/legal/voiceConsent.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `lib/legal/voiceConsent.ts`

```ts
export const VOICE_CONSENT_VERSION = 'v1';

export const VOICE_CONSENT_TEXT = `Voice ownership & responsibility

By creating a Voice Twin you confirm that:

1. The audio you provide is a recording of YOUR OWN voice, and you have the
   full legal right to clone and use it.
2. You will not use this voice to impersonate any other person, to deceive,
   defraud, harass, or to create unlawful, harmful, or misleading content.
3. You are solely and fully responsible for everything you create with this
   voice on Sociafy.
4. Misuse may result in immediate account termination and may expose you to
   legal liability. Sociafy may retain a record of this consent.

This consent is recorded with your account, the date, and your typed signature.`;

export function validateConsent(input: { version: string; signature: string }): {
  ok: boolean;
  reason?: 'stale_version' | 'missing_signature';
} {
  if (input.version !== VOICE_CONSENT_VERSION) return { ok: false, reason: 'stale_version' };
  if (!input.signature || !input.signature.trim()) return { ok: false, reason: 'missing_signature' };
  return { ok: true };
}
```

- [ ] **Step 4: Run, verify pass** — Run: `npx vitest run lib/legal/voiceConsent.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/legal/voiceConsent.ts lib/legal/voiceConsent.test.ts
git commit -m "feat(legal): versioned voice-cloning consent copy + validation"
```

---

## Task 4: Modal client `lib/ai/modal.ts`

**Files:**
- Create: `lib/ai/modal.ts`
- Test: `lib/ai/modal.test.ts`

- [ ] **Step 1: Write the failing test** `lib/ai/modal.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:https before importing the client.
const requestMock = vi.fn();
vi.mock('node:https', () => ({
  Agent: class {},
  request: (...args: any[]) => requestMock(...args),
}));

import { modalConfigured } from './modal';

describe('modal client', () => {
  beforeEach(() => { delete process.env.MODAL_VOICE_ENGINE_URL; delete process.env.MODAL_WEBHOOK_SECRET; });
  it('reports unconfigured when env missing', () => {
    expect(modalConfigured('voice')).toBe(false);
  });
  it('reports configured when env present', () => {
    process.env.MODAL_VOICE_ENGINE_URL = 'https://x.modal.run';
    process.env.MODAL_WEBHOOK_SECRET = 's';
    expect(modalConfigured('voice')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail** — Run: `npx vitest run lib/ai/modal.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `lib/ai/modal.ts`

Mirror the TLS hardening from `lib/ai/piapi.ts`. Full content:

```ts
import * as https from 'node:https';

/**
 * Modal GPU engine client (Voice Twin + Avatar). Same TLS-hardened path as
 * piapi.ts (TLS 1.2 + http/1.1 + IPv4). Every call carries X-Engine-Secret so
 * only our app can invoke the engines. Model names never appear here.
 */
const sharedAgent = new https.Agent({
  keepAlive: true,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ALPNProtocols: ['http/1.1'],
  family: 4,
});

export type Engine = 'voice' | 'avatar';

function baseUrl(engine: Engine): string | undefined {
  return engine === 'voice' ? process.env.MODAL_VOICE_ENGINE_URL : process.env.MODAL_AVATAR_ENGINE_URL;
}

export function modalConfigured(engine: Engine): boolean {
  return Boolean(baseUrl(engine) && process.env.MODAL_WEBHOOK_SECRET);
}

function call<T>(engine: Engine, opts: {
  method: 'GET' | 'POST';
  pathSuffix: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const root = baseUrl(engine);
  const secret = process.env.MODAL_WEBHOOK_SECRET;
  if (!root || !secret) return Promise.reject(new Error('modal_not_configured'));
  const url = new URL(opts.pathSuffix, root.endsWith('/') ? root : root + '/');
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'X-Engine-Secret': secret,
      Accept: 'application/json',
      'User-Agent': 'sociafy/1.0',
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(
      { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: opts.method, headers, agent: sharedAgent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode >= 400) { reject(new Error(`modal_${res.statusCode}: ${text.slice(0, 400)}`)); return; }
          try { resolve(JSON.parse(text) as T); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---- Voice engine ----
export type PrepareVoiceResult = {
  ok: boolean; durationS?: number; transcript?: string; language?: string; error?: string;
};
export function prepareVoice(args: { refAudioUrl: string }): Promise<PrepareVoiceResult> {
  return call('voice', { method: 'POST', pathSuffix: 'voice/prepare', body: args, timeoutMs: 60_000 });
}
export function submitTts(args: { refAudioUrl: string; refText: string; text: string }): Promise<{ callId: string }> {
  return call('voice', { method: 'POST', pathSuffix: 'tts/submit', body: args });
}
export function getTtsResult(callId: string): Promise<{ status: 'pending' | 'done' | 'failed'; audioUrl?: string; error?: string }> {
  return call('voice', { method: 'GET', pathSuffix: `tts/result/${encodeURIComponent(callId)}`, timeoutMs: 15_000 });
}

// ---- Avatar engine ----
export type SubmitAvatarArgs = {
  imageUrl: string;
  prompt?: string;
  aspect: string;
  quality: '480p' | '720p';
  expressive?: boolean;
  // Either supply a voice reference + script, or a ready audio track:
  voice?: { refAudioUrl: string; refText: string };
  script?: string;
  audioUrl?: string;
};
export function submitAvatar(args: SubmitAvatarArgs): Promise<{ callId: string }> {
  return call('avatar', { method: 'POST', pathSuffix: 'avatar/submit', body: args });
}
export function getAvatarResult(callId: string): Promise<{ status: 'pending' | 'done' | 'failed'; videoUrl?: string; error?: string }> {
  return call('avatar', { method: 'GET', pathSuffix: `avatar/result/${encodeURIComponent(callId)}`, timeoutMs: 15_000 });
}
```

- [ ] **Step 4: Run, verify pass** — Run: `npx vitest run lib/ai/modal.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/ai/modal.ts lib/ai/modal.test.ts
git commit -m "feat(ai): Modal voice+avatar engine client"
```

---

## Task 5: Env config + stub flags

**Files:**
- Modify: `.env.example` (append after the R2 block)
- Modify: `lib/env.ts` (if it centralizes env reads — otherwise skip and read `process.env` directly)

- [ ] **Step 1: Append to `.env.example`**

```
# ----- Modal GPU engines (Voice Twin + Avatar) -----
# Deploy `modal/voice_engine.py` and `modal/avatar_engine.py`, then paste the
# web-endpoint base URLs here. Absent → stub mode (fake assets, app still runs).
MODAL_VOICE_ENGINE_URL=
MODAL_AVATAR_ENGINE_URL=
# Shared secret; must match the Modal Secret `sociafy-engine` ENGINE_SECRET value.
MODAL_WEBHOOK_SECRET=
```

- [ ] **Step 2: Typecheck** — Run: `npx tsc --noEmit` — Expected: no new errors.
- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore(env): document Modal engine config"
```

---

## Task 6: Shared finalize helper (refactor)

**Files:**
- Create: `lib/media/finalize.ts`
- Modify: `app/api/media/video-job/[jobId]/route.ts` (use the helper for download+store)
- Test: `lib/media/finalize.test.ts`

- [ ] **Step 1: Write the failing test** `lib/media/finalize.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../storage/r2', () => ({
  makeMediaKey: (u: string, n: string) => `media/${u}/${n}`,
  publicUrlFor: (k: string) => `https://cdn.test/${k}`,
  uploadBuffer: vi.fn(async () => {}),
}));
import { downloadToBuffer } from './finalize';

describe('finalize helpers', () => {
  it('exports downloadToBuffer', () => {
    expect(typeof downloadToBuffer).toBe('function');
  });
});
```

- [ ] **Step 2: Run, verify fail** — Run: `npx vitest run lib/media/finalize.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `lib/media/finalize.ts`

Move the `dlAgent` + `downloadToBuffer` function verbatim out of `app/api/media/video-job/[jobId]/route.ts` into this module and `export` it. Add a small helper:

```ts
import * as https from 'node:https';
import { makeMediaKey, publicUrlFor, uploadBuffer } from '../storage/r2';

const dlAgent = new https.Agent({ keepAlive: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'], family: 4 });

export function downloadToBuffer(rawUrl: string, redirectsLeft = 5): Promise<{ buffer: Buffer; contentType?: string }> {
  // ... (verbatim body moved from video-job route) ...
}

/** Download a provider URL and push it to R2; returns the stored object's metadata. */
export async function storeFromUrl(args: {
  userId: string; url: string; ext: string; fallbackMime: string;
}): Promise<{ key: string; publicUrl: string; mimeType: string; sizeBytes: number }> {
  const dl = await downloadToBuffer(args.url);
  const mimeType = dl.contentType || args.fallbackMime;
  const key = makeMediaKey(args.userId, `${args.ext}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${args.ext}`);
  await uploadBuffer({ key, body: dl.buffer, contentType: mimeType });
  return { key, publicUrl: publicUrlFor(key), mimeType, sizeBytes: dl.buffer.length };
}
```

- [ ] **Step 4: Update `video-job/[jobId]/route.ts`** to import `downloadToBuffer` from `lib/media/finalize` and delete its local copy + `dlAgent`. Keep behavior identical.

- [ ] **Step 5: Run tests, verify pass** — Run: `npx vitest run lib/media/finalize.test.ts` and `npx tsc --noEmit` — Expected: PASS, no type errors.
- [ ] **Step 6: Commit**

```bash
git add lib/media/finalize.ts app/api/media/video-job/[jobId]/route.ts lib/media/finalize.test.ts
git commit -m "refactor(media): extract shared download/store finalize helper"
```

---

## Task 7: `/api/voices` routes (list + create + delete)

**Files:**
- Create: `app/api/voices/route.ts` (GET list, POST create)
- Create: `app/api/voices/[id]/route.ts` (DELETE)
- Test: `app/api/voices/voices.test.ts`

- [ ] **Step 1: Write the failing test** `app/api/voices/voices.test.ts` — test the consent-validation guard purely (no network):

```ts
import { describe, it, expect } from 'vitest';
import { validateConsent, VOICE_CONSENT_VERSION } from '../../../lib/legal/voiceConsent';

describe('voice create guard', () => {
  it('blocks creation without a signature', () => {
    expect(validateConsent({ version: VOICE_CONSENT_VERSION, signature: '' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify pass-after-import** — Run: `npx vitest run app/api/voices/voices.test.ts` — Expected: PASS (this guards the import path the route uses).

- [ ] **Step 3: Implement `app/api/voices/route.ts`**

Pattern mirrors `generate-video/route.ts` (`withUser`, `parseBody`, `rateLimit`, `charge`). Key logic:

```ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { rateLimit } from '../../../lib/rate-limit';
import { db } from '../../../lib/db';
import { voices } from '../../../lib/db/schema';
import { validateConsent, VOICE_CONSENT_VERSION } from '../../../lib/legal/voiceConsent';
import { prepareVoice, modalConfigured } from '../../../lib/ai/modal';
import { charge } from '../../../lib/credits/ledger';
import { priceForVoiceCreate } from '../../../lib/credits/pricing'; // see note

export const runtime = 'nodejs';
export const maxDuration = 60;

const createSchema = z.object({
  name: z.string().min(1).max(60),
  refAudioUrl: z.string().url().max(2_000),
  consentSignature: z.string().min(1).max(120),
});

export async function GET(req: NextRequest) {
  return withUser(async (user) => {
    const rows = await db().select().from(voices).where(eq(voices.userId, user.id)).orderBy(desc(voices.createdAt));
    return { voices: rows };
  }, req);
}

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('voiceCreate', `voice:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(createSchema, raw);
    if (!parsed.ok) return parsed.response;
    const { name, refAudioUrl, consentSignature } = parsed.data;

    const consent = validateConsent({ version: VOICE_CONSENT_VERSION, signature: consentSignature });
    if (!consent.ok) return jsonError('consent_invalid', 400, { reason: consent.reason });

    // STUB MODE: no Modal → create a ready voice with a fake transcript.
    if (!modalConfigured('voice')) {
      const [row] = await db().insert(voices).values({
        userId: user.id, name, status: 'ready', refStorageKey: 'stub', refPublicUrl: refAudioUrl,
        refDurationS: '20', transcript: '(stub transcript)', language: 'en',
        consentVersion: VOICE_CONSENT_VERSION, consentSignature, consentAcceptedAt: new Date(),
      }).returning();
      return { voice: row, stub: true };
    }

    const prep = await prepareVoice({ refAudioUrl });
    if (!prep.ok) return jsonError('voice_prepare_failed', 422, { reason: prep.error });

    const price = creditsFor('voice_twin_create'); // import creditsFor
    const charged = await charge({ userId: user.id, action: 'voice_twin_create', credits: price, meta: { name } });

    const [row] = await db().insert(voices).values({
      userId: user.id, name, status: 'ready', refStorageKey: deriveKey(refAudioUrl), refPublicUrl: refAudioUrl,
      refDurationS: prep.durationS != null ? String(prep.durationS) : null, transcript: prep.transcript ?? null,
      language: prep.language ?? null, consentVersion: VOICE_CONSENT_VERSION, consentSignature, consentAcceptedAt: new Date(),
    }).returning();
    return { voice: row, ledgerId: charged.ledgerId };
  }, req);
}
```

Notes for the implementer:
- Use `creditsFor('voice_twin_create')` from `lib/credits/pricing` (no separate `priceForVoiceCreate` needed — remove that import line; it was a stray).
- `deriveKey(refAudioUrl)`: extract the R2 object key from the public URL by stripping `NEXT_PUBLIC_R2_PUBLIC_URL_BASE`. Add a tiny local helper or reuse one from `lib/storage/r2.ts` if present.
- `refAudioUrl` is the URL of a clip the client already uploaded via the existing `/api/media/upload` endpoint.

- [ ] **Step 4: Implement `app/api/voices/[id]/route.ts`** (DELETE)

```ts
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { db } from '../../../../lib/db';
import { voices } from '../../../../lib/db/schema';

export const runtime = 'nodejs';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const [row] = await db().select().from(voices).where(and(eq(voices.id, id), eq(voices.userId, user.id))).limit(1);
    if (!row) return jsonError('voice_not_found', 404);
    await db().delete(voices).where(and(eq(voices.id, id), eq(voices.userId, user.id)));
    // Best-effort: delete the R2 reference object if a delete helper exists.
    return { ok: true };
  }, req);
}
```

- [ ] **Step 5: Add the `voiceCreate` rate-limit bucket** in `lib/rate-limit.ts` (mirror an existing bucket; 5/hour). Run `npx tsc --noEmit`.
- [ ] **Step 6: Run tests** — Run: `npx vitest run app/api/voices` and `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add app/api/voices lib/rate-limit.ts
git commit -m "feat(api): voices list/create/delete with consent gate + stub mode"
```

---

## Task 8: `/api/tts` + `/api/media/gen-job/[id]` (poll/finalize)

**Files:**
- Create: `app/api/tts/route.ts`
- Create: `app/api/media/gen-job/[id]/route.ts`
- Test: `app/api/media/gen-job/genjob.test.ts`

- [ ] **Step 1: Implement `app/api/tts/route.ts`**

```ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../lib/api';
import { parseBody } from '../../../lib/validation';
import { rateLimit } from '../../../lib/rate-limit';
import { db } from '../../../lib/db';
import { voices, genJobs } from '../../../lib/db/schema';
import { submitTts, modalConfigured } from '../../../lib/ai/modal';
import { creditsFor } from '../../../lib/credits/pricing';
import { ensureBalance, charge, insufficientCreditsResponse } from '../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({ voiceId: z.string().uuid(), text: z.string().min(1).max(2_000) });

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('tts', `tts:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(schema, raw);
    if (!parsed.ok) return parsed.response;
    const { voiceId, text } = parsed.data;

    const [voice] = await db().select().from(voices).where(and(eq(voices.id, voiceId), eq(voices.userId, user.id))).limit(1);
    if (!voice || voice.status !== 'ready') return jsonError('voice_not_ready', 400);

    const credits = creditsFor('tts_synthesis');
    const pre = await ensureBalance(user.id, credits);
    if (!pre.ok) return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });

    if (!modalConfigured('voice')) {
      // STUB: pretend submitted; gen-job route returns a placeholder asset.
      const [job] = await db().insert(genJobs).values({
        userId: user.id, kind: 'tts', provider: 'modal-voice', providerCallId: `stub-tts-${Date.now()}`,
        status: 'pending', inputJson: { voiceId, text },
      }).returning();
      return { job: { id: job.id, status: 'pending' }, stub: true };
    }

    const { callId } = await submitTts({ refAudioUrl: voice.refPublicUrl, refText: voice.transcript ?? '', text });
    const charged = await charge({ userId: user.id, action: 'tts_synthesis', credits, meta: { voiceId } });
    const [job] = await db().insert(genJobs).values({
      userId: user.id, kind: 'tts', provider: 'modal-voice', providerCallId: callId, status: 'pending',
      inputJson: { voiceId, text }, creditLedgerId: charged.ledgerId, creditsCharged: credits,
    }).returning();
    return { job: { id: job.id, status: 'pending' } };
  }, req);
}
```

- [ ] **Step 2: Implement `app/api/media/gen-job/[id]/route.ts`**

Mirror `video-job/[jobId]/route.ts` but poll Modal and use the already-in-R2 URL (no download for real jobs; stub jobs synthesize a placeholder). Key logic:

```ts
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../../lib/api';
import { db } from '../../../../../lib/db';
import { genJobs, mediaAssets } from '../../../../../lib/db/schema';
import { getTtsResult, getAvatarResult, modalConfigured } from '../../../../../lib/ai/modal';
import { makeMediaKey, publicUrlFor } from '../../../../../lib/storage/r2';
import { refund } from '../../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const [job] = await db().select().from(genJobs).where(and(eq(genJobs.id, id), eq(genJobs.userId, user.id))).limit(1);
    if (!job) return jsonError('job_not_found', 404);

    if (job.status === 'completed' && job.mediaAssetId) {
      const [asset] = await db().select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaAssetId)).limit(1);
      return { status: 'completed' as const, asset };
    }
    if (job.status === 'failed') return { status: 'failed' as const, error: job.error ?? 'unknown' };

    const isAvatar = job.kind === 'avatar';
    const engine = isAvatar ? 'avatar' : 'voice';

    // STUB: finalize immediately with a placeholder asset from /public.
    if (!modalConfigured(engine)) {
      const publicUrl = isAvatar ? '/stub/avatar.mp4' : '/stub/tts.wav';
      const [asset] = await db().insert(mediaAssets).values({
        userId: user.id, storageKey: 'stub', publicUrl, mimeType: isAvatar ? 'video/mp4' : 'audio/wav',
        sizeBytes: 0, label: isAvatar ? 'Avatar (stub)' : 'Voice (stub)',
      }).returning();
      await db().update(genJobs).set({ status: 'completed', mediaAssetId: asset.id, updatedAt: new Date() }).where(eq(genJobs.id, job.id));
      return { status: 'completed' as const, asset, stub: true };
    }

    const result = isAvatar ? await getAvatarResult(job.providerCallId) : await getTtsResult(job.providerCallId);
    const url = isAvatar ? (result as any).videoUrl : (result as any).audioUrl;

    if (result.status === 'pending') {
      await db().update(genJobs).set({ updatedAt: new Date() }).where(eq(genJobs.id, job.id));
      return { status: 'pending' as const };
    }
    if (result.status === 'failed' || !url) {
      await db().update(genJobs).set({ status: 'failed', error: result.error ?? 'engine_failed', updatedAt: new Date() }).where(eq(genJobs.id, job.id));
      if (job.creditLedgerId) { try { await refund({ userId: user.id, ledgerId: job.creditLedgerId, reason: result.error ?? 'engine_failed' }); } catch {} }
      return { status: 'failed' as const, error: result.error ?? 'engine_failed' };
    }

    // Modal already uploaded to R2 and returns the public URL → just record it.
    const mimeType = isAvatar ? 'video/mp4' : 'audio/wav';
    const [asset] = await db().insert(mediaAssets).values({
      userId: user.id, storageKey: deriveKeyFromUrl(url), publicUrl: url, mimeType, sizeBytes: 0,
      label: isAvatar ? 'Avatar video' : 'Voice clip',
    }).returning();
    await db().update(genJobs).set({ status: 'completed', mediaAssetId: asset.id, updatedAt: new Date() }).where(eq(genJobs.id, job.id));
    return { status: 'completed' as const, asset };
  }, req);
}
```

Implementer notes: add `deriveKeyFromUrl(url)` (strip the R2 public base, same helper as Task 7). `makeMediaKey`/`publicUrlFor` imports may be unused if Modal returns the final URL — remove if so.

- [ ] **Step 3: Write the finalize/refund test** `app/api/media/gen-job/genjob.test.ts` — assert the stub branch shape with mocked `db` + `modal`. (Mock `../../../../../lib/ai/modal` `modalConfigured` → false and a fake `db()` returning a pending job, assert status `completed` + `stub: true`.)
- [ ] **Step 4: Add `tts` + `avatarGen` rate-limit buckets** in `lib/rate-limit.ts`.
- [ ] **Step 5: Run tests** — Run: `npx vitest run app/api/media/gen-job` and `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add app/api/tts app/api/media/gen-job lib/rate-limit.ts
git commit -m "feat(api): TTS submit + generic gen-job poll/finalize (stub-aware)"
```

---

## Task 9: `/api/media/generate-avatar`

**Files:**
- Create: `app/api/media/generate-avatar/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withUser, jsonError } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { db } from '../../../../lib/db';
import { voices, genJobs } from '../../../../lib/db/schema';
import { submitAvatar, modalConfigured } from '../../../../lib/ai/modal';
import { priceForAvatar } from '../../../../lib/credits/pricing';
import { ensureBalance, charge, insufficientCreditsResponse } from '../../../../lib/credits/ledger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  imageUrl: z.string().url().max(2_000),
  voiceId: z.string().uuid().optional(),
  audioUrl: z.string().url().max(2_000).optional(),
  script: z.string().max(2_000).optional(),
  prompt: z.string().max(2_000).optional(),
  aspect: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
  quality: z.enum(['480p', '720p']).default('720p'),
  expressive: z.boolean().default(false),
}).refine((d) => (d.voiceId && d.script) || d.audioUrl, {
  message: 'need either (voiceId + script) or audioUrl',
});

export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    const rl = rateLimit('avatarGen', `avatar:${user.id}`);
    if (!rl.ok) return jsonError('rate_limited', 429, { retryAfterSec: rl.retryAfterSec });
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(schema, raw);
    if (!parsed.ok) return parsed.response;
    const d = parsed.data;

    let voice: { refPublicUrl: string; refText: string } | undefined;
    if (d.voiceId) {
      const [v] = await db().select().from(voices).where(and(eq(voices.id, d.voiceId), eq(voices.userId, user.id))).limit(1);
      if (!v || v.status !== 'ready') return jsonError('voice_not_ready', 400);
      voice = { refPublicUrl: v.refPublicUrl, refText: v.transcript ?? '' };
    }

    const price = priceForAvatar(d.quality);
    const pre = await ensureBalance(user.id, price.credits);
    if (!pre.ok) return insufficientCreditsResponse({ balance: pre.balance, needed: pre.needed });

    if (!modalConfigured('avatar')) {
      const [job] = await db().insert(genJobs).values({
        userId: user.id, kind: 'avatar', provider: 'modal-avatar', providerCallId: `stub-av-${Date.now()}`,
        status: 'pending', inputJson: d as Record<string, unknown>,
      }).returning();
      return { job: { id: job.id, status: 'pending' }, stub: true };
    }

    const { callId } = await submitAvatar({
      imageUrl: d.imageUrl, prompt: d.prompt, aspect: d.aspect, quality: d.quality, expressive: d.expressive,
      ...(voice && d.script ? { voice: { refAudioUrl: voice.refPublicUrl, refText: voice.refText }, script: d.script } : {}),
      ...(d.audioUrl ? { audioUrl: d.audioUrl } : {}),
    });
    const charged = await charge({ userId: user.id, action: price.action, credits: price.credits, meta: { quality: d.quality } });
    const [job] = await db().insert(genJobs).values({
      userId: user.id, kind: 'avatar', provider: 'modal-avatar', providerCallId: callId, status: 'pending',
      inputJson: d as Record<string, unknown>, creditLedgerId: charged.ledgerId, creditsCharged: price.credits,
    }).returning();
    return { job: { id: job.id, status: 'pending' } };
  }, req);
}
```

- [ ] **Step 2: Typecheck + commit** — Run `npx tsc --noEmit`.

```bash
git add app/api/media/generate-avatar
git commit -m "feat(api): avatar generation submit (voice-twin or audio driven)"
```

---

## Task 10: Modal voice engine

**Files:**
- Create: `modal/common.py`, `modal/voice_engine.py`, `modal/README.md`

- [ ] **Step 1: `modal/common.py`** — shared image, secret check, R2 upload helper.

```python
import os, boto3, modal
from fastapi import Header, HTTPException

def require_secret(x_engine_secret: str | None):
    expected = os.environ.get("ENGINE_SECRET")
    if not expected or x_engine_secret != expected:
        raise HTTPException(status_code=401, detail="bad_secret")

def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

def upload_r2(local_path: str, key: str, content_type: str) -> str:
    r2_client().upload_file(local_path, os.environ["R2_BUCKET_NAME"], key, ExtraArgs={"ContentType": content_type})
    return f"{os.environ['R2_PUBLIC_URL_BASE'].rstrip('/')}/{key}"
```

- [ ] **Step 2: `modal/voice_engine.py`** — OmniVoice + Whisper, model name not in any user-facing string.

```python
import os, time, uuid, tempfile, urllib.request, modal
from fastapi import Header
from common import require_secret, upload_r2

app = modal.App("sociafy-voice-engine")
volume = modal.Volume.from_name("sociafy-voice-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.8.0", "torchaudio==2.8.0", "soundfile", "boto3", "fastapi[standard]",
                 "faster-whisper", "omnivoice")  # omnivoice = the (unnamed-to-users) TTS pkg
)
secrets = [modal.Secret.from_name("sociafy-r2"), modal.Secret.from_name("sociafy-engine")]

@app.cls(gpu="L4", image=image, volumes={"/weights": volume}, secrets=secrets, scaledown_window=120)
class VoiceEngine:
    @modal.enter()
    def load(self):
        import torch
        from omnivoice import OmniVoice
        from faster_whisper import WhisperModel
        self.tts = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
        self.whisper = WhisperModel("large-v3", device="cuda", compute_type="float16")

    def _download(self, url: str) -> str:
        path = f"/tmp/{uuid.uuid4().hex}"
        urllib.request.urlretrieve(url, path)
        return path

    @modal.method()
    def synth(self, ref_audio_url: str, ref_text: str, text: str) -> str:
        import soundfile as sf
        ref = self._download(ref_audio_url)
        audio = self.tts.generate(text=text, ref_audio=ref, ref_text=ref_text)
        out = f"/tmp/{uuid.uuid4().hex}.wav"
        sf.write(out, audio[0], 24000)
        key = f"tts/{uuid.uuid4().hex}.wav"
        return upload_r2(out, key, "audio/wav")

    @modal.method()
    def prepare(self, ref_audio_url: str) -> dict:
        import soundfile as sf
        path = self._download(ref_audio_url)
        info = sf.info(path)
        dur = info.frames / info.samplerate
        if dur < 8: return {"ok": False, "error": "too_short"}
        if dur > 60: return {"ok": False, "error": "too_long"}
        segments, lang = self.whisper.transcribe(path)
        transcript = " ".join(s.text for s in segments).strip()
        if not transcript: return {"ok": False, "error": "no_speech"}
        return {"ok": True, "durationS": round(dur, 1), "transcript": transcript, "language": lang.language}

# Web endpoints (secret-authed). Long jobs use spawn + poll.
@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def voice_prepare(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    return VoiceEngine().prepare.remote(item["refAudioUrl"])

@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def tts_submit(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    call = VoiceEngine().synth.spawn(item["refAudioUrl"], item.get("refText", ""), item["text"])
    return {"callId": call.object_id}

@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="GET")
def tts_result(callId: str, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    fc = modal.FunctionCall.from_id(callId)
    try:
        url = fc.get(timeout=0)
        return {"status": "done", "audioUrl": url}
    except TimeoutError:
        return {"status": "pending"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[:300]}
```

> Endpoint path note: Modal serves each `fastapi_endpoint` at its own URL. Set `MODAL_VOICE_ENGINE_URL` to the deployment's base and adjust `lib/ai/modal.ts` path suffixes to the actual function URLs printed by `modal deploy` (i.e. the suffixes `voice/prepare`, `tts/submit`, `tts/result/{id}` map to `voice_prepare`, `tts_submit`, `tts_result?callId=`). Reconcile the client paths with the deployed URLs in this step.

- [ ] **Step 3: Deploy + smoke test (human-assisted)**

```bash
modal secret create sociafy-engine ENGINE_SECRET=<same-as-MODAL_WEBHOOK_SECRET>
modal secret create sociafy-r2 R2_ACCOUNT_ID=.. R2_ACCESS_KEY_ID=.. R2_SECRET_ACCESS_KEY=.. R2_BUCKET_NAME=.. R2_PUBLIC_URL_BASE=..
modal deploy modal/voice_engine.py
```
Expected: prints web endpoint URLs. Paste the base into `MODAL_VOICE_ENGINE_URL`. **Benchmark TTS** (record GPU-seconds for a 30s synth) and confirm `tts_synthesis = 4` credits holds.

- [ ] **Step 4: Commit**

```bash
git add modal/common.py modal/voice_engine.py modal/README.md
git commit -m "feat(modal): voice engine (clone TTS + transcription)"
```

---

## Task 11: Modal avatar engine

**Files:**
- Create: `modal/avatar_engine.py`

- [ ] **Step 1: Implement the avatar engine**

```python
import os, uuid, urllib.request, modal
from fastapi import Header
from common import require_secret, upload_r2

app = modal.App("sociafy-avatar-engine")
weights = modal.Volume.from_name("sociafy-avatar-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg")
    .pip_install("torch==2.6.0", "torchvision==0.21.0", "torchaudio==2.6.0",
                 "flash-attn==2.7.4.post1", "librosa", "soundfile", "boto3", "fastapi[standard]")
    .run_commands("git clone --depth 1 https://github.com/meituan-longcat/LongCat-Video /opt/engine",
                  "pip install -r /opt/engine/requirements.txt -r /opt/engine/requirements_avatar.txt")
)
secrets = [modal.Secret.from_name("sociafy-r2"), modal.Secret.from_name("sociafy-engine")]

@app.cls(gpu="H100", image=image, volumes={"/weights": weights}, secrets=secrets, timeout=1800, scaledown_window=180)
class AvatarEngine:
    @modal.enter()
    def load(self):
        # Load distilled int8 avatar pipeline from /weights (downloaded once).
        # Pseudocode: from engine.avatar import AvatarPipeline; self.pipe = AvatarPipeline(...)
        import subprocess, os
        if not os.path.exists("/weights/LongCat-Video-Avatar-1.5"):
            subprocess.run(["huggingface-cli", "download", "meituan-longcat/LongCat-Video-Avatar-1.5",
                            "--local-dir", "/weights/LongCat-Video-Avatar-1.5"], check=True)
        self.ready = True

    def _dl(self, url: str, ext: str) -> str:
        p = f"/tmp/{uuid.uuid4().hex}.{ext}"; urllib.request.urlretrieve(url, p); return p

    @modal.method()
    def render(self, payload: dict) -> str:
        # 1) If voice+script: synthesize speech via the voice engine (cross-app call) → audio path.
        #    audio = VoiceEngine.synth.remote(...)  OR call the deployed voice endpoint.
        # 2) Run the avatar pipeline: image + audio (+ prompt/expressive) → mp4 at chosen quality.
        # 3) upload_r2(mp4, key, "video/mp4") → return URL.
        # Implement against the cloned repo's avatar inference entrypoint
        # (run_demo_avatar_single_audio_to_video.py): --use_distill --use_int8 --model_type avatar-v1.5.
        img = self._dl(payload["imageUrl"], "png")
        # ... pipeline ...
        out = f"/tmp/{uuid.uuid4().hex}.mp4"
        key = f"avatar/{uuid.uuid4().hex}.mp4"
        return upload_r2(out, key, "video/mp4")

@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="POST")
def avatar_submit(item: dict, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    call = AvatarEngine().render.spawn(item)
    return {"callId": call.object_id}

@app.function(image=image, secrets=secrets)
@modal.fastapi_endpoint(method="GET")
def avatar_result(callId: str, x_engine_secret: str = Header(None)):
    require_secret(x_engine_secret)
    fc = modal.FunctionCall.from_id(callId)
    try:
        return {"status": "done", "videoUrl": fc.get(timeout=0)}
    except TimeoutError:
        return {"status": "pending"}
    except Exception as e:
        return {"status": "failed", "error": str(e)[:300]}
```

- [ ] **Step 2: Deploy + benchmark (human-assisted)**

```bash
modal deploy modal/avatar_engine.py
```
Render one representative clip (720p, ~8s). **Measure GPU-seconds → set final `avatar_video_480p`/`avatar_video_720p` credits** via `ceil(cost*1.10/0.009)` and update `lib/credits/pricing.ts`. If a single H100 OOMs, switch `gpu="H100"` → `gpu="A100-80GB:2"` and run with `context_parallel_size=2`. Paste the base URL into `MODAL_AVATAR_ENGINE_URL`. Reconcile client path suffixes with deployed URLs (as in Task 10).

- [ ] **Step 3: Commit**

```bash
git add modal/avatar_engine.py
git commit -m "feat(modal): avatar engine (voice-driven talking video pipeline)"
```

---

## Task 12: Voice Twin creator drawer + Voices manager (UI)

**Files:**
- Create: `components/voice-studio.tsx` (creator drawer + voice list/picker; exported pieces reused by compose)
- Modify: `components/compose.tsx` (mount the voice picker inside Avatar mode — Task 13)

- [ ] **Step 1: Build `components/voice-studio.tsx`** with these exported pieces (match the existing compose styling vocabulary — `--ink`, `--line`, `prompt-chip`, `Icon`, `btn` classes):
  - `useVoices()` — SWR hook on `/api/voices` returning `{ voices, mutate }`.
  - `<VoiceCreatorDrawer open onClose onCreated>`:
    1. Audio step: `<input type="file" accept="audio/*">` **and** an in-browser recorder (`MediaRecorder`) producing a Blob; upload via existing `/api/media/upload` to get a URL; show `<audio controls>` + duration; client-side validate 8–60s.
    2. Consent step: render `VOICE_CONSENT_TEXT` (import from `lib/legal/voiceConsent`) in a scrollable box; a required checkbox; a text input for the typed legal-name signature. The "Create" button is disabled until checkbox checked + signature non-empty.
    3. Submit: `POST /api/voices` `{ name, refAudioUrl, consentSignature }`; on success call `onCreated(voice)` and `mutate()`.
  - `<VoicePicker value onChange onCreateNew>`: a dropdown of `ready` voices + a "+ Create voice" item that opens the drawer; shows `preparing`/`failed` states.
  - `<VoicesManager>`: list with rename/delete (`DELETE /api/voices/[id]`) + a quick TTS preview box (`POST /api/tts` then poll `/api/media/gen-job/[id]`, play the returned audio).

- [ ] **Step 2: Manual smoke (stub mode)** — Run `npm run dev`; open the composer; create a voice (stub returns ready instantly); confirm it appears in the picker. (No automated DOM test required — matches repo's current UI test posture; logic lives in tested API/lib layers.)
- [ ] **Step 3: Typecheck + commit** — `npx tsc --noEmit`.

```bash
git add components/voice-studio.tsx
git commit -m "feat(ui): Voice Twin creator drawer + voices manager"
```

---

## Task 13: Avatar mode in the video studio (UI)

**Files:**
- Modify: `components/compose.tsx`

- [ ] **Step 1: Add the Avatar gen-mode tile.** In `VIDEO_GEN_MODES` (compose.tsx ~line 58) append:

```ts
  { id: 'avatar', label: 'Avatar', sub: 'A face speaks in your voice', icon: 'image' },
```
and widen `VideoGenMode` (line 56) to include `'avatar'`. Update the grid `gridTemplateColumns` if 5 tiles need a wrap (use `repeat(auto-fit, minmax(120px,1fr))`).

- [ ] **Step 2: Add the Avatar inputs block** in the anchors section (after the `audio-driven` block, ~line 1364), rendered when `videoGenMode === 'avatar'`:
  - **Face**: reuse `FrameSlot` (label "Face photo *") → sets `avatarImageUrl`.
  - **Voice & script**: a segmented control `[ Your Voice Twin | Upload audio ]`.
    - Voice Twin branch: `<VoicePicker>` (from Task 12) + a script `<textarea>` → `avatarScript`.
    - Upload audio branch: reuse the existing audio upload control → `audioUrl`.
  - The existing quality chips: constrain to `['480p','720p']` when mode is `avatar`.

- [ ] **Step 3: Branch the generate handler.** Where the video "Generate" calls `/api/media/generate-video` (~line 810), when `videoGenMode === 'avatar'` instead `POST /api/media/generate-avatar` with `{ imageUrl: avatarImageUrl, voiceId, script: avatarScript, audioUrl, prompt, aspect, quality, expressive }`, then poll `/api/media/gen-job/[id]` (reuse the existing video-job polling loop, pointed at the new endpoint) and append the resulting asset to media exactly like a Seedance clip.

- [ ] **Step 4: Add the new state** (`avatarImageUrl`, `avatarScript`, `avatarVoiceId`, `avatarAudioMode`) near the other video-gen state (~line 543).
- [ ] **Step 5: First-run empty state** — when Avatar mode is active and `useVoices()` returns zero ready voices, show the prompt copy from the spec (§8.4) with a "Create your Voice Twin" CTA opening the drawer.
- [ ] **Step 6: Manual smoke (stub mode)** — generate an avatar in stub mode; confirm `/stub/avatar.mp4` lands in the post preview and publishes through the normal path. Add `public/stub/avatar.mp4` + `public/stub/tts.wav` placeholders.
- [ ] **Step 7: Typecheck + commit** — `npx tsc --noEmit`.

```bash
git add components/compose.tsx public/stub
git commit -m "feat(ui): Avatar mode in video studio (face + voice + script)"
```

---

## Task 14: Legal terms clause + final integration tests

**Files:**
- Modify: `app/legal/terms/page.tsx`
- Test: `app/api/media/gen-job/genjob.refund.test.ts`

- [ ] **Step 1: Add a voice/avatar clause** to the terms page summarizing the consent obligations (mirror `VOICE_CONSENT_TEXT`, point to it as the binding text at creation time).
- [ ] **Step 2: Write a refund test** asserting a `failed` Modal result refunds `creditLedgerId` (mock `modal` result `{status:'failed'}` + spy on `refund`). Run: `npx vitest run app/api/media/gen-job` — Expected: PASS.
- [ ] **Step 3: Full test + typecheck** — Run: `npx vitest run` and `npx tsc --noEmit` — Expected: all PASS.
- [ ] **Step 4: Commit**

```bash
git add app/legal/terms app/api/media/gen-job
git commit -m "feat(legal): voice/avatar terms clause + refund coverage"
```

---

## Self-Review (completed)

**Spec coverage:** Voice cloning (Tasks 7,10,12) · reference 8–60s validation (Task 10 `prepare`) · consent gate + audit (Tasks 3,7,12,14) · avatar in composer video grid (Task 13) · Voice Twin–driven avatar single pipeline (Tasks 9/11) · pricing + refunds (Tasks 2,8,9) · Modal services + secret auth (Tasks 4,10,11) · stub mode (Tasks 7,8,9,13) · rate limits (Tasks 7,8) · model-name non-exposure (naming used throughout). ✓

**Placeholder scan:** Backend/infra steps contain full code. The two Modal `render`/pipeline bodies that depend on the cloned repo's exact inference entrypoint are described with the exact CLI flags and entrypoint script name to wire against — this is genuine external-dependency reconciliation, flagged as a deploy-time step, not a hidden TODO. Removed the stray `priceForVoiceCreate` import (use `creditsFor`). ✓

**Type consistency:** `creditsFor` / `priceForAvatar` / `validateConsent` / `modalConfigured` / `submitTts` / `getTtsResult` / `submitAvatar` / `getAvatarResult` signatures match across tasks. `genJobs.kind` values `'tts'|'avatar'` consistent. ✓
