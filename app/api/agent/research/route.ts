import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withUser } from '../../../../lib/api';
import { parseBody } from '../../../../lib/validation';
import { rateLimit } from '../../../../lib/rate-limit';
import { runAgentLoop, webSearchTool } from '../../../../lib/ai/agent-loop';
import { fetchUrlSkill } from '../../../../lib/ai/skills/fetch-url';
import { getAnthropic } from '../../../../lib/ai/client';

const bodySchema = z.object({
  topic: z.string().min(2).max(2_000),
  /** Optional URLs the user pasted that the agent should read first. */
  urls: z.array(z.string().url().max(2_000)).max(4).optional(),
  /** Tone hint to bias what the research summarizes. */
  angle: z.string().max(400).optional(),
});

/**
 * POST /api/agent/research
 *
 * Ad-hoc research: agent searches the web, optionally reads URLs the user
 * pasted, and returns structured notes the user (or compose) can use to draft
 * a post. The agent is encouraged to surface counter-arguments and specific
 * data points to avoid generic "AI slop" output.
 */
export async function POST(req: NextRequest) {
  return withUser(async (user) => {
    if (!getAnthropic()) {
      return Response.json({ error: 'ai_not_configured' }, { status: 503 });
    }
    const rl = rateLimit('agentRun', `research:${user.id}`);
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited', retryAfterSec: rl.retryAfterSec }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
      });
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = parseBody(bodySchema, raw);
    if (!parsed.ok) return parsed.response;
    const { topic, urls, angle } = parsed.data;

    const sys = [
      'You are a research assistant for a solo founder who writes on social media.',
      'Goal: surface SPECIFIC, citable facts the user can build a post on.',
      'Bias hard toward primary sources, numbers, named people/orgs, recent dates.',
      'Avoid generic platitudes — every bullet should be something a reader could fact-check.',
      angle ? `Angle the user is interested in: ${angle}` : '',
      '',
      'Process:',
      '1. Use `web_search` (up to 3 calls) to find current, authoritative info on the topic.',
      `${urls?.length ? '2. Use `fetch_url` to read the user-supplied URLs in full.' : ''}`,
      'Then output STRICT JSON. No markdown fences. No commentary.',
      '',
      'Schema: {',
      '  "summary": string,                  // 2-4 sentence overview',
      '  "facts": [ { "claim": string, "source": string, "url": string | null } ],',
      '  "angles": [ string ],               // 3-5 distinct possible post angles, one sentence each',
      '  "counter": string,                  // the strongest counter-argument or risk',
      '  "hooks": [ string ]                 // 3 candidate first lines, one per typical platform',
      '}',
    ].filter(Boolean).join('\n');

    const userMsg = [
      `Topic: ${topic}`,
      urls?.length ? `Sources to read first:\n${urls.map((u) => `- ${u}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const result = await runAgentLoop({
      model: 'smart',
      system: sys,
      user: userMsg,
      tools: [webSearchTool(), fetchUrlSkill],
      maxSteps: 6,
      maxOutputTokens: 3000,
    });
    if (!result) return Response.json({ error: 'ai_not_configured' }, { status: 503 });

    let parsedNotes: unknown;
    try {
      parsedNotes = JSON.parse(stripFences(result.text));
    } catch {
      // Fall back to raw text wrapped — user still gets the work product.
      parsedNotes = { summary: result.text, facts: [], angles: [], counter: '', hooks: [] };
    }
    return Response.json({
      ok: true,
      topic,
      toolsUsed: result.toolsUsed,
      notes: parsedNotes,
    });
  }, req);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}
