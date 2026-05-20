import type OpenAI from 'openai';
import { getOpenAI, MODELS } from './client';

/**
 * Tool-use loop runner against OpenAI's Responses API.
 *
 * The Responses API exposes both:
 *  - **Hosted tools** Anthropic-style — `web_search` runs on OpenAI's side, we
 *    just declare it. Results come back grounded and cited.
 *  - **Custom tools** the model can call with a JSON-schema-validated payload;
 *    we execute the handler and feed the result back.
 *
 * The loop drives the model with `previous_response_id` so we don't have to
 * shuttle the conversation manually — OpenAI maintains the state.
 */

export type CustomToolHandler = (input: unknown) => Promise<unknown> | unknown;

export type ToolSpec =
  | {
      type: 'hosted';
      def: { type: 'web_search'; [k: string]: unknown };
    }
  | {
      type: 'custom';
      def: {
        type: 'function';
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
      handler: CustomToolHandler;
    };

type ChatMessage = OpenAI.Responses.ResponseInputItem;

export type LoopOptions = {
  model?: keyof typeof MODELS;
  /** System / developer instructions for the model. */
  system: string;
  /** Initial user input. */
  user: string;
  tools: ToolSpec[];
  maxSteps?: number;
  /** Cap on output tokens per model turn. */
  maxOutputTokens?: number;
};

export type LoopResult = {
  /** Final assistant text content concatenated. */
  text: string;
  /** Distinct tool names called during the loop. */
  toolsUsed: string[];
  /** Number of model turns consumed. */
  steps: number;
};

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_TOKENS = 3500;

/**
 * Drive a Responses-API tool loop until the model returns a final answer.
 * Returns null when the client isn't configured (stub mode).
 */
export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult | null> {
  const openai = getOpenAI();
  if (!openai) return null;

  const model = MODELS[opts.model ?? 'smart'];
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const tools = opts.tools.map((t) => t.def) as OpenAI.Responses.Tool[];
  const handlerByName = new Map<string, CustomToolHandler>(
    opts.tools
      .filter((t): t is Extract<ToolSpec, { type: 'custom' }> => t.type === 'custom')
      .map((t) => [t.def.name, t.handler]),
  );

  const toolsUsed = new Set<string>();
  let input: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let previousResponseId: string | undefined;
  let lastText = '';

  for (let step = 0; step < maxSteps; step++) {
    const response = await openai.responses.create({
      model,
      input,
      tools,
      max_output_tokens: opts.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      previous_response_id: previousResponseId,
      // Lets us pick up the tool calls and feed results back inline.
      store: true,
    });
    previousResponseId = response.id;

    // Pull the model's text reply (if any) for the final return value.
    const newText = extractText(response);
    if (newText) lastText = newText;

    // Collect any tool calls the model wants us to execute (custom tools).
    const calls = collectFunctionCalls(response);
    for (const c of calls) toolsUsed.add(c.name);
    // Track hosted web_search calls too. SDK types use string-literal unions
    // we can't always narrow against in older versions, so cast to string.
    for (const item of response.output ?? []) {
      if ((item as { type?: string }).type === 'web_search_call') toolsUsed.add('web_search');
    }

    if (calls.length === 0) {
      // No more tool calls. Either we got our final text or the model is
      // done thinking — return whatever text we have.
      break;
    }

    // Build the next input batch with tool outputs.
    const nextInput: ChatMessage[] = [];
    for (const call of calls) {
      const handler = handlerByName.get(call.name);
      let output: string;
      if (!handler) {
        output = JSON.stringify({ error: 'unknown_tool' });
      } else {
        try {
          const result = await handler(safeJsonParse(call.arguments));
          output = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          output = JSON.stringify({ error: msg.slice(0, 500) });
        }
      }
      nextInput.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output,
      });
    }
    input = nextInput;
  }

  return {
    text: lastText.trim(),
    toolsUsed: Array.from(toolsUsed),
    steps: maxSteps,
  };
}

type CollectedCall = { name: string; call_id: string; arguments: string };

function collectFunctionCalls(response: OpenAI.Responses.Response): CollectedCall[] {
  const calls: CollectedCall[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'function_call') {
      calls.push({
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments ?? '{}',
      });
    }
  }
  return calls;
}

function extractText(response: OpenAI.Responses.Response): string {
  // The SDK provides output_text as a convenience aggregator. Fall back to
  // walking output_message blocks if it's empty (some SDK versions don't
  // populate it).
  const direct = response.output_text;
  if (direct && direct.trim()) return direct;
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') parts.push(c.text);
      }
    }
  }
  return parts.join('');
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Convenience builder for OpenAI's hosted web_search tool. The model
 * autonomously decides when to call it; OpenAI executes the search and
 * returns grounded results in the same response.
 */
export function webSearchTool(): ToolSpec {
  return {
    type: 'hosted',
    def: { type: 'web_search' },
  };
}
