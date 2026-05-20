import fs from 'fs';
import path from 'path';
import { getOpenAI, MODELS } from './client';

/**
 * Media-prompt rewriter.
 *
 * Image and video models have very different prompting conventions — concrete
 * camera-language for gpt-image-1, verb-led motion for Seedance, etc. Rather
 * than make the user learn that, we keep human-authored "skill" files next to
 * the code and push them into the rewriter's system prompt at call time.
 *
 * The rewriter is intentionally a small, fast model call. If anything fails
 * (no key, parse error, empty response), we return the user's original prompt
 * unchanged — generation should still go through.
 */

const SKILLS_DIR = path.join(process.cwd(), 'lib', 'ai', 'skills', 'prompts');

export type RewriteTarget = 'gpt-image-1' | 'seedance-2';

const SKILL_BY_TARGET: Record<RewriteTarget, string> = {
  'gpt-image-1': 'gpt-image-1.md',
  'seedance-2': 'seedance-2.md',
};

// Cache: skill files don't change at runtime.
const skillCache = new Map<RewriteTarget, string>();

function loadSkill(target: RewriteTarget): string {
  const cached = skillCache.get(target);
  if (cached) return cached;
  try {
    const text = fs.readFileSync(path.join(SKILLS_DIR, SKILL_BY_TARGET[target]), 'utf-8');
    skillCache.set(target, text);
    return text;
  } catch {
    return '';
  }
}

export type RewriteArgs = {
  userPrompt: string;
  target: RewriteTarget;
  /** Optional caption / post text the media should harmonize with. */
  caption?: string;
};

export type RewriteResult = {
  prompt: string;
  /** True when we actually called the model. False = fell through to original. */
  enhanced: boolean;
};

export async function rewritePromptForMedia(args: RewriteArgs): Promise<RewriteResult> {
  const openai = getOpenAI();
  if (!openai || !args.userPrompt.trim()) {
    return { prompt: args.userPrompt, enhanced: false };
  }

  const skill = loadSkill(args.target);
  const sys = [
    `You are a prompt rewriter for the ${args.target} generation model.`,
    'Take the user\'s loose description and produce ONE polished prompt for the model.',
    'Return ONLY the prompt text — no explanations, no quotes, no labels, no markdown.',
    '',
    skill,
  ].filter(Boolean).join('\n');

  const userMsg = [
    args.caption ? `Post caption (for tone alignment, optional):\n"""${args.caption}"""` : '',
    `User description:\n"""${args.userPrompt}"""`,
  ].filter(Boolean).join('\n\n');

  try {
    const resp = await openai.responses.create({
      model: MODELS.fast,
      input: [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ],
      max_output_tokens: 500,
    });
    const text = (resp.output_text ?? '').trim();
    if (!text) return { prompt: args.userPrompt, enhanced: false };
    // Strip any stray quote wrappers or "Prompt:" labels the model still emits.
    const cleaned = text
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^prompt:\s*/i, '')
      .trim();
    return { prompt: cleaned || args.userPrompt, enhanced: true };
  } catch {
    return { prompt: args.userPrompt, enhanced: false };
  }
}
