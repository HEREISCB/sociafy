import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { runAgentLoop, webSearchTool } from '../../../../lib/ai/agent-loop';
import { fetchUrlSkill } from '../../../../lib/ai/skills/fetch-url';
import { getAnthropic } from '../../../../lib/ai/client';

const bodySchema = z.object({
  brand: z.string().min(2).max(200),
  /** Optional competitor list to also scan for. */
  competitors: z.array(z.string().max(200)).max(8).optional(),
  /** Window in days to consider 'recent'. */
  recentDays: z.number().int().min(1).max(30).optional(),
});

/**
 * POST /api/agent/brand-monitor
 *
 * Agent searches the web for recent mentions of the user's brand (and
 * optionally competitors), surfaces sentiment, and suggests one or two posts
 * the user could publish in response.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!getAnthropic()) {
      return Response.json({ error: 'ai_not_configured' }, { status: 503 });
    }
    const rl = rateLimit('agentRun', `brand:${user.id}`);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
      });
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;
    const { brand, competitors, recentDays } = parsed.data;
    const days = recentDays ?? 14;

    const sys = [
      'You are a brand monitoring agent for a solo founder.',
      `The user runs: ${brand}.`,
      competitors?.length ? `Competitors to also scan: ${competitors.join(', ')}.` : '',
      '',
      'Process:',
      `1. Use \`web_search\` to find mentions and recent context (within ~${days} days).`,
      '2. Optionally \`fetch_url\` to read a specific mention in full.',
      '3. Return STRICT JSON only, no commentary, no fences.',
      '',
      'Schema: {',
      '  "summary": string,                          // 2-3 sentence overview of current chatter',
      '  "mentions": [ { "source": string, "url": string, "sentiment": "positive"|"neutral"|"negative", "snippet": string } ],',
      '  "competitorMoves": [ { "competitor": string, "what": string, "url": string | null } ],',
      '  "respondWith": [ { "angle": string, "draftText": string } ]  // 1-3 post ideas',
      '}',
      '',
      'Be honest about uncertainty — if you can\'t find recent mentions, say so in summary and return empty arrays.',
    ].filter(Boolean).join('\n');

    const userMsg = `Search for recent (last ${days} days) public discussion of "${brand}".${competitors?.length ? ` Also check: ${competitors.join(', ')}.` : ''}`;

    const result = await runAgentLoop({
      model: 'smart',
      system: sys,
      messages: [{ role: 'user', content: userMsg }],
      tools: [webSearchTool(4), fetchUrlSkill],
      maxSteps: 7,
      maxTokens: 3500,
    });
    if (!result) return Response.json({ error: 'ai_not_configured' }, { status: 503 });

    let parsedReport: unknown;
    try {
      parsedReport = JSON.parse(stripFences(result.text));
    } catch {
      parsedReport = { summary: result.text, mentions: [], competitorMoves: [], respondWith: [] };
    }
    return Response.json({
      ok: true,
      brand,
      windowDays: days,
      toolsUsed: result.toolsUsed,
      report: parsedReport,
    });
  }, req);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}
