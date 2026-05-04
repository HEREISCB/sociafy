import Anthropic from '@anthropic-ai/sdk';
import { env, isStubMode } from '../env';

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic | null {
  if (isStubMode.ai()) return null;
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.anthropic.apiKey! });
  return _client;
}

export const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  smart: 'claude-sonnet-4-6',
} as const;
