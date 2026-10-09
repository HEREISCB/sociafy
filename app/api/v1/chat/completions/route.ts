import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { withApiKey } from '../../../../../lib/api-key';
import { rateLimit } from '../../../../../lib/rate-limit';
import { getOpenAI, MODELS } from '../../../../../lib/ai/client';
import { CHAT_LIMITS, CHAT_MODEL_IDS, CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModelId } from '../../../../../lib/ai/models';
import { charge, ensureBalance, InsufficientCreditsError } from '../../../../../lib/credits/ledger';
import { priceForChat } from '../../../../../lib/credits/pricing';
import { imageFormat } from '../../../../../lib/media/probe';
import {
  apiError,
  classifyImageFailure,
  fetchReferenceImages,
  findChargeBySource,
  type ImageFailure,
  isUniqueViolation,
  logImageFailure,
  providerPreflight,
  readIdempotencyKey,
  REFERENCE_LIMITS,
} from '../../shared';

export const runtime = 'nodejs';
// Image fetching (up to REFERENCE_LIMITS.totalBudgetMs) + one provider call
// (PROVIDER_TIMEOUT_MS, one retry). Nothing is charged until the call returns,
// so a timeout here costs the caller nothing — but it costs us the call.
export const maxDuration = 300;

/**
 * POST /api/v1/chat/completions — metered text + vision, OpenAI-compatible.
 *
 * Request and response follow the OpenAI chat-completions shape so an existing
 * integration switches by changing base URL (`https://sociafy.app/api/v1`) and
 * key. Errors keep OUR envelope (`{ error, message }`), like every v1 route.
 *
 * Billing differs from /images and /videos because the price is only known
 * after the call: pre-flight ensureBalance on a worst-case estimate, call the
 * provider, THEN charge the actual usage. Consequences, all deliberate:
 *  - a failed call has no charge to refund, and never consumes its
 *    Idempotency-Key (a retry with the same key is a fresh attempt);
 *  - if the balance drains between pre-flight and charge (parallel calls), the
 *    charge refuses with 402 and we eat one call's provider cost — bounded, and
 *    cheaper than the reserve/partial-refund pair a hold would write per call.
 *
 * Image URLs are fetched HERE through fetchReferenceImages (https only, SSRF
 * guard, no redirects, type + magic bytes, byte caps) and forwarded as data:
 * URLs — never handed to the provider as URLs. Passing them through would be
 * SSRF-safe for us, but (1) a bad URL would surface as an opaque provider 400
 * instead of a specific, uncharged 400 of ours, and (2) a customer's host is not
 * ours to disclose to a third party (same rule as rehostReferences).
 */

const PROVIDER_TIMEOUT_MS = 120_000;

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});
const textContent = z.union([z.string(), z.array(textPart).min(1)]);

const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent }),
  // OpenAI's newer name for system on reasoning models; same meaning here.
  z.object({ role: z.literal('developer'), content: textContent }),
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.discriminatedUnion('type', [textPart, imagePart])).min(1)]),
  }),
  z.object({ role: z.literal('assistant'), content: textContent }),
]);

/**
 * Not `.strict()`: OpenAI clients routinely send knobs we have no use for
 * (`user`, `seed`, `top_p`…), and rejecting those would break the drop-in
 * promise. Unknown fields are ignored. The ones whose silent absence would
 * change the answer's MEANING are rejected explicitly in superRefine instead.
 */
const bodySchema = z
  .object({
    model: z.string().default(DEFAULT_CHAT_MODEL),
    messages: z.array(messageSchema).min(1).max(CHAT_LIMITS.maxMessages),
    max_tokens: z.number().int().min(1).max(CHAT_LIMITS.maxOutputTokens).optional(),
    max_completion_tokens: z.number().int().min(1).max(CHAT_LIMITS.maxOutputTokens).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    response_format: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('text') }),
        z.object({ type: z.literal('json_object') }),
        z.object({
          type: z.literal('json_schema'),
          json_schema: z.looseObject({ name: z.string().min(1).max(64) }),
        }),
      ])
      .optional(),
    stream: z.boolean().optional(),
    n: z.number().int().optional(),
    tools: z.unknown().optional(),
    functions: z.unknown().optional(),
  })
  .superRefine((b, ctx) => {
    if (!(CHAT_MODEL_IDS as string[]).includes(b.model)) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: `Use one of: ${CHAT_MODEL_IDS.join(', ')}.` });
    }
    // ponytail: no streaming. Metering a stream means charging after a body
    // the client may abandon mid-way; add it with stream_options.include_usage
    // when a caller actually needs tokens-as-they-arrive.
    if (b.stream === true) {
      ctx.addIssue({ code: 'custom', path: ['stream'], message: 'Streaming is not supported. Send stream: false (or omit it).' });
    }
    if (b.n !== undefined && b.n !== 1) {
      ctx.addIssue({ code: 'custom', path: ['n'], message: 'Only n: 1 is supported.' });
    }
    if (b.tools !== undefined || b.functions !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['tools'], message: 'Tool / function calling is not supported.' });
    }
    const images = b.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((p) => p.type === 'image_url').length;
    if (textChars(b) > CHAT_LIMITS.maxTextChars) {
      ctx.addIssue({ code: 'custom', path: ['messages'], message: `All message text together must be at most ${CHAT_LIMITS.maxTextChars} characters.` });
    }
    if (images > CHAT_LIMITS.maxImages) {
      ctx.addIssue({ code: 'custom', path: ['messages'], message: `At most ${CHAT_LIMITS.maxImages} images per request.` });
    }
  });

type Body = z.infer<typeof bodySchema>;

function textChars(body: Pick<Body, 'messages'>): number {
  let n = 0;
  for (const m of body.messages) {
    if (typeof m.content === 'string') n += m.content.length;
    else for (const p of m.content) if (p.type === 'text') n += p.text.length;
  }
  return n;
}

export async function POST(req: NextRequest) {
  return withApiKey(req, async (auth) => {
    // Database only: the openai flag would answer with image wording.
    const pre = providerPreflight({ r2: false });
    if (pre) return pre;
    const openai = getOpenAI();
    if (!openai) return apiError('service_unavailable', 503, 'Chat is temporarily unavailable.');

    const idem = readIdempotencyKey(req, 'chat');
    if (!idem.ok) return idem.response;
    const source = idem.source;

    const raw = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError('invalid_request', 400, 'Request body failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;
    const modelId = body.model as ChatModelId;
    const tier = CHAT_MODELS[modelId].tier;
    const providerModel = MODELS[tier];

    // After validation (a 400 costs nothing, not even a token), before money.
    // `general` (60/min), not the image bucket's 3 per 5 min: chat is called
    // per keystroke-ish UI action, and the spend caps are the real ceiling.
    const rl = rateLimit('general', `v1chat:${auth.apiKeyId}`);
    if (!rl.ok) {
      return apiError(
        'rate_limited',
        429,
        'Too many requests. Retry shortly.',
        { retry_after_sec: rl.retryAfterSec },
        { 'retry-after': String(rl.retryAfterSec) },
      );
    }

    if (source) {
      const replay = await replayOf(auth.userId, source);
      if (replay) return replay;
    }

    // Images before any money question: every way they can be wrong is the
    // caller's input, and a rejected image must be an uncharged 400.
    const resolved = await resolveImages(body);
    if (!resolved.ok) return resolved.response;

    const maxOut = body.max_completion_tokens ?? body.max_tokens ?? CHAT_LIMITS.defaultOutputTokens;
    // Worst case: one token per character (no tokenizer is that bad on real
    // text), a high-detail ceiling per image, the schema, and the full output
    // budget. Only a pre-flight — the charge below is what is billed.
    const estPrompt =
      textChars(body) +
      resolved.count * CHAT_LIMITS.worstCaseImageTokens +
      JSON.stringify(body.response_format ?? '').length +
      body.messages.length * 8;
    const worst = priceForChat(tier, estPrompt, maxOut);
    const funded = await ensureBalance(auth.userId, worst.credits);
    if (!funded.ok) throw new InsufficientCreditsError(funded.balance, funded.needed);

    // gpt-5-family (reasoning) models reject `temperature` other than 1 and
    // require `reasoning_effort` instead, so temperature is accepted but not
    // forwarded to them. Reasoning tokens count toward max_completion_tokens,
    // hence a `minimal` default: callers written for non-reasoning models send
    // small max_tokens and would otherwise get an empty answer.
    const reasoning = /^(gpt-5|o\d)/.test(providerModel);
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: providerModel,
      messages: resolved.messages,
      max_completion_tokens: maxOut,
      ...(reasoning
        ? { reasoning_effort: body.reasoning_effort ?? 'minimal' }
        : body.temperature !== undefined
          ? { temperature: body.temperature }
          : {}),
      ...(body.response_format
        ? { response_format: body.response_format as ChatCompletionCreateParamsNonStreaming['response_format'] }
        : {}),
    };

    let res;
    try {
      res = await openai.chat.completions.create(params, { maxRetries: 1, timeout: PROVIDER_TIMEOUT_MS });
    } catch (e) {
      // Nothing was charged, so nothing to refund and the key stays unclaimed.
      const failure = classifyChatFailure(e);
      logImageFailure('v1/chat', e, failure);
      return apiError(failure.code, failure.status, failure.message);
    }

    const promptTokens = res.usage?.prompt_tokens;
    const completionTokens = res.usage?.completion_tokens;
    // Non-streaming responses always carry usage; if one ever doesn't, bill the
    // pre-flight worst case rather than give the call away.
    const unit =
      promptTokens === undefined || completionTokens === undefined
        ? (console.error('[v1/chat] provider returned no usage; billing the worst-case estimate'), worst)
        : priceForChat(tier, promptTokens, completionTokens);

    const out = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion' as const,
      created: Math.floor(Date.now() / 1000),
      // Our public id, never the provider's — see lib/ai/models.ts.
      model: modelId,
      choices: res.choices.map((c) => ({
        index: c.index,
        message: { role: 'assistant' as const, content: c.message.content ?? null, refusal: c.message.refusal ?? null },
        finish_reason: c.finish_reason,
      })),
      usage: {
        prompt_tokens: promptTokens ?? 0,
        completion_tokens: completionTokens ?? 0,
        total_tokens: res.usage?.total_tokens ?? 0,
        completion_tokens_details: { reasoning_tokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
      },
      credits_charged: unit.credits,
    };

    try {
      await charge({
        userId: auth.userId,
        action: unit.action,
        credits: unit.credits,
        meta: {
          // MANDATORY: the auth layer's daily-cap query reads meta.apiKeyId.
          apiKeyId: auth.apiKeyId,
          via: 'api_v1',
          model: modelId,
          promptTokens: promptTokens ?? null,
          completionTokens: completionTokens ?? null,
          images: resolved.count,
          // The response is stored ONLY when an Idempotency-Key was sent: it is
          // what a replay returns, and there is nothing else to replay from.
          ...(source ? { source, response: out } : {}),
        },
      });
    } catch (e) {
      if (source && isUniqueViolation(e)) {
        // A twin with the same key finished first and paid. Hand back ITS answer,
        // never a second charge; our provider call is the cost of the race.
        const replay = await replayOf(auth.userId, source);
        if (replay) return replay;
        return apiError('request_in_progress', 409, 'A request with this Idempotency-Key is still in flight.');
      }
      throw e; // InsufficientCreditsError → withApiKey renders the 402.
    }

    return Response.json(out, { headers: { 'idempotency-replay': 'false' } });
  });
}

type Resolved =
  | { ok: true; messages: ChatCompletionMessageParam[]; count: number }
  | { ok: false; response: Response };

const DATA_URL_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Turn every image part into a vetted data: URL and build the provider's
 * message list. https URLs go through fetchReferenceImages (the v1 trust
 * boundary for remote images); data: URLs get the same type, magic-byte and
 * size checks locally. Error codes are the documented `reference_*` ones.
 */
async function resolveImages(body: Body): Promise<Resolved> {
  const urls: string[] = [];
  for (const m of body.messages) {
    if (m.role === 'user' && typeof m.content !== 'string') {
      for (const p of m.content) if (p.type === 'image_url') urls.push(p.image_url.url);
    }
  }

  const remote = urls.filter((u) => !u.startsWith('data:'));
  const fetched = remote.length ? await fetchReferenceImages(remote) : { ok: true as const, files: [] };
  if (!fetched.ok) return fetched;

  const dataUrls: string[] = [];
  let bytes = 0;
  let r = 0;
  for (const [i, url] of urls.entries()) {
    const bad = (code: string, message: string) =>
      ({ ok: false as const, response: apiError(code, 400, message, { image_index: i }) });
    let buf: Buffer;
    let type: string;
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const header = comma > 0 ? url.slice(5, comma).toLowerCase() : '';
      type = header.split(';')[0];
      if (!header.endsWith(';base64') || !DATA_URL_TYPES.has(type)) {
        return bad('reference_type_unsupported', 'data: images must be base64-encoded image/png, image/jpeg or image/webp.');
      }
      // Size from the base64 length BEFORE decoding, so an oversized payload is
      // never materialised twice.
      if (((url.length - comma - 1) * 3) / 4 > REFERENCE_LIMITS.maxBytes) {
        return bad('reference_too_large', `Each image must be under ${REFERENCE_LIMITS.maxBytes / 1024 / 1024} MB.`);
      }
      buf = Buffer.from(url.slice(comma + 1), 'base64');
      const fmt = imageFormat(buf);
      if (!fmt || `image/${fmt}` !== type) {
        return bad('reference_type_unsupported', `That data: URL is not really ${type} — its declared type and its bytes disagree.`);
      }
    } else {
      const file = fetched.files[r++];
      type = file.type;
      buf = Buffer.from(await file.arrayBuffer());
    }
    bytes += buf.length;
    if (bytes > CHAT_LIMITS.maxTotalImageBytes) {
      return bad('reference_too_large', `All images together must be under ${CHAT_LIMITS.maxTotalImageBytes / 1024 / 1024} MB.`);
    }
    dataUrls.push(`data:${type};base64,${buf.toString('base64')}`);
  }

  let k = 0;
  const messages = body.messages.map((m): ChatCompletionMessageParam => {
    if (m.role !== 'user' || typeof m.content === 'string') return m as ChatCompletionMessageParam;
    return {
      role: 'user',
      content: m.content.map((p) =>
        p.type === 'text'
          ? p
          : { type: 'image_url' as const, image_url: { url: dataUrls[k++], ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) } },
      ),
    };
  });
  return { ok: true, messages, count: urls.length };
}

/**
 * classifyImageFailure's codes, with chat wording. Two additions it lacks: a
 * provider 400 that names a request field is the CALLER's body (too long for
 * the context window, a schema the provider refuses), not our configuration;
 * and a plain 429 is provider back-pressure, not a broken call. No message from
 * upstream reaches the caller (shared.ts rule 1) — only the field name, which
 * is in our own (OpenAI-compatible) vocabulary.
 */
function classifyChatFailure(e: unknown): ImageFailure {
  const base = classifyImageFailure(e);
  const o = (e ?? {}) as { status?: unknown; code?: unknown; param?: unknown };
  const param = typeof o.param === 'string' ? o.param : '';
  if (base.code === 'prompt_rejected') {
    return { ...base, message: 'The request was rejected by the content filter. Nothing was charged.' };
  }
  if (o.status === 400 && (o.code === 'context_length_exceeded' || /^(messages|response_format)/.test(param))) {
    return {
      code: 'invalid_request',
      status: 400,
      message: `The model could not accept this request${param ? ` (problem at \`${param}\`)` : ''}. Shorten or fix it. Nothing was charged.`,
    };
  }
  if (o.status === 429 && base.code !== 'service_unavailable') {
    return { code: 'service_unavailable', status: 503, message: 'Chat is busy right now. Nothing was charged. Retry shortly.' };
  }
  const messages: Record<string, string> = {
    service_unavailable: 'Chat is temporarily unavailable. Nothing was charged. This is not a problem with your request.',
    configuration_error: 'Chat is misconfigured on our side and has been logged. Nothing was charged. Retrying will not help until we fix it.',
    upstream_error: 'The model did not return an answer. Nothing was charged. Safe to retry.',
  };
  return { ...base, message: messages[base.code] ?? base.message };
}

/** The stored answer for an Idempotency-Key, if its call already succeeded. */
async function replayOf(userId: string, source: string): Promise<Response | null> {
  const original = await findChargeBySource(userId, source);
  if (!original) return null;
  const stored = (original.meta as { response?: unknown } | null)?.response;
  if (!stored) return apiError('request_in_progress', 409, 'A request with this Idempotency-Key is still in flight.');
  return Response.json(stored, { headers: { 'idempotency-replay': 'true' } });
}
