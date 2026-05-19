import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, MODELS } from './client';

/**
 * Generic tool-use loop runner.
 *
 * The Anthropic API returns `stop_reason === 'tool_use'` when the model wants
 * to call a tool. We execute each requested tool, append the tool_result, and
 * call the API again until the model returns `end_turn` or we hit max steps.
 *
 * Supports:
 *  - Server-side custom tools (with handler functions)
 *  - Anthropic-hosted tools like `web_search_20250305` which run on
 *    Anthropic's side — we just pass the tool spec through.
 */

type AnthropicToolUnion = Anthropic.Messages.ToolUnion;
type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlock = Anthropic.Messages.ContentBlock;
type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

export type CustomToolHandler = (input: unknown) => Promise<unknown> | unknown;

export type ToolSpec =
  | {
      type: 'hosted';
      // The full tool definition passed through to Anthropic (e.g. web_search_20250305).
      def: AnthropicToolUnion;
    }
  | {
      type: 'custom';
      def: Anthropic.Messages.Tool;
      handler: CustomToolHandler;
    };

export type LoopOptions = {
  model?: keyof typeof MODELS;
  system: string;
  messages: MessageParam[];
  tools: ToolSpec[];
  maxSteps?: number;
  maxTokens?: number;
  /** Forwarded to Anthropic — controls how the model decides which tool to call. */
  toolChoice?: Anthropic.Messages.ToolChoice;
};

export type LoopResult = {
  /** Final assistant text content concatenated. Empty when the model only made tool calls. */
  text: string;
  /** Number of model turns consumed. */
  steps: number;
  /** Distinct tool names called during the loop. */
  toolsUsed: string[];
  /** Full final response from Anthropic (last call). */
  raw: Anthropic.Messages.Message;
};

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_TOKENS = 3500;

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;

  const tools = opts.tools.map((t) => t.def) as AnthropicToolUnion[];
  const handlerByName = new Map<string, CustomToolHandler>(
    opts.tools.filter((t): t is Extract<ToolSpec, { type: 'custom' }> => t.type === 'custom')
      .map((t) => [t.def.name, t.handler]),
  );

  const model = MODELS[opts.model ?? 'smart'];
  const messages: MessageParam[] = [...opts.messages];
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolsUsed = new Set<string>();
  let last: Anthropic.Messages.Message | null = null;

  for (let step = 0; step < maxSteps; step++) {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system,
      tools,
      tool_choice: opts.toolChoice,
      messages,
    });
    last = resp;

    // Collect tool_use blocks the model wants us to execute (server-side custom tools).
    const toolUses: ToolUseBlock[] = resp.content.filter(
      (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use',
    );

    // No tool calls or model says it's done — return.
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      break;
    }

    // Run each requested custom tool. Hosted tools (web_search) are executed
    // by Anthropic itself and arrive back as server_tool_use / web_search_tool_result
    // blocks — we don't handle those here, they're already in the assistant message.
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolsUsed.add(use.name);
      const handler = handlerByName.get(use.name);
      if (!handler) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ error: 'unknown_tool' }),
          is_error: true,
        });
        continue;
      }
      try {
        const result = await handler(use.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ error: msg }),
          is_error: true,
        });
      }
    }

    // If the model only used hosted tools (no custom-tool dispatches needed),
    // bail — there's nothing for us to feed back. Anthropic has already
    // executed the hosted call and the result is in the assistant message.
    if (toolResults.length === 0) break;

    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: toolResults });
  }

  if (!last) {
    return { text: '', steps: 0, toolsUsed: [], raw: {} as Anthropic.Messages.Message };
  }

  // Track hosted tool usage too — pull from any server_tool_use blocks.
  for (const b of last.content) {
    if (b.type === 'server_tool_use') toolsUsed.add(b.name);
  }

  const text = last.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return {
    text,
    steps: maxSteps,
    toolsUsed: Array.from(toolsUsed),
    raw: last,
  };
}

/**
 * Convenience builder for the hosted web_search tool. Anthropic executes the
 * search; we just declare it as available and Anthropic returns cited results
 * the model already grounded its output on.
 */
export function webSearchTool(maxUses = 3): ToolSpec {
  return {
    type: 'hosted',
    def: {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: maxUses,
    } as AnthropicToolUnion,
  };
}
