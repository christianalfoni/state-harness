import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  ModelPricing,
  Provider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ToolCall,
} from "../types.js";

/**
 * Published per-1M-token prices (US$), by model. Cache-read is 0.1× input and
 * cache-write (5-min TTL) is 1.25× input. Update when prices change.
 */
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export interface AnthropicProviderOptions {
  /** Reuse an existing client, or let the adapter construct one from `apiKey`. */
  client?: Anthropic;
  /** Defaults to the `ANTHROPIC_API_KEY` env var via the SDK. */
  apiKey?: string;
  /** Model id. Defaults to the latest Opus. */
  model?: string;
  /** Max output tokens per turn. Turns are just tool calls, so this stays small. */
  maxTokens?: number;
  /**
   * Allow multiple tool calls in a single turn. Default true. Set false to force
   * exactly one per turn (`disable_parallel_tool_use`).
   */
  parallelToolCalls?: boolean;
  /**
   * Per-1M-token pricing for cost estimation. Defaults to the built-in rate for
   * `model` (if known). Set this for a model the adapter doesn't have rates for,
   * or to override them.
   */
  pricing?: ModelPricing;
}

/**
 * Anthropic Messages API adapter. Forces tool use with `tool_choice: { type:
 * "any" }`, so the model emits *only* tool calls — never a text turn.
 */
export function anthropicProvider(options: AnthropicProviderOptions = {}): Provider {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? "claude-opus-4-8";
  const maxTokens = options.maxTokens ?? 8192;
  const disableParallel = options.parallelToolCalls === false;
  const pricing = options.pricing ?? PRICING[model];

  return {
    name: "anthropic",
    pricing,
    async generate(input: ProviderGenerateInput): Promise<ProviderGenerateOutput> {
      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          ...(input.system ? { system: input.system } : {}),
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
          })),
          tool_choice: { type: "any", disable_parallel_tool_use: disableParallel },
          messages: input.messages.map(toAnthropicMessage),
        },
        { signal: input.signal },
      );

      const toolCalls: ToolCall[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      return {
        toolCalls,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? undefined,
        },
        raw: response,
      };
    },
  };
}

function toAnthropicMessage(message: Message): Anthropic.MessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.text };
    case "assistant":
      return {
        role: "assistant",
        content: message.toolCalls.map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      };
    case "tool":
      // Tool results are delivered to the model as a user turn.
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
  }
}
