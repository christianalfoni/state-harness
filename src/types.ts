import type { z } from "zod";
import type { AgentState } from "./cognition.js";

/**
 * A single tool call the model wants to make — the only thing it ever emits. In
 * a tool-only harness there are no free-text turns: every step is one or more
 * tool calls (a mix of the built-in state tools and your effect tools).
 */
export interface ToolCall {
  /** Provider-assigned id. Correlates the result back to the call. */
  id: string;
  /** Name of the tool the model wants to run. */
  name: string;
  /** Raw, unvalidated arguments as produced by the model. */
  input: unknown;
}

/** The outcome of running a {@link ToolCall}, fed back to the model. */
export interface ToolResult {
  /** Matches {@link ToolCall.id}. */
  toolCallId: string;
  /** Stringified result content handed back to the model. */
  content: string;
  /** When true, the model is told this call failed. */
  isError?: boolean;
}

/**
 * Provider-agnostic conversation entry — the model's working memory, not the
 * user's interface. Strictly: user messages, then alternating assistant(toolCalls)
 * / tool(results) turns. No assistant text ever appears.
 */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

/** Token accounting, when the provider reports it. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Per-1M-token prices (US$) for the model a provider calls. The API returns token
 * *counts* but not prices, so the provider supplies these published rates; the
 * harness multiplies them by {@link Usage} to estimate cost.
 */
export interface ModelPricing {
  /** $/1M uncached input tokens. */
  input: number;
  /** $/1M output tokens. */
  output: number;
  /** $/1M cache-read tokens. */
  cacheRead?: number;
  /** $/1M cache-write tokens. */
  cacheWrite?: number;
}

/** A tool as the provider needs to see it (name + JSON Schema). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft-07) describing the tool's input object. */
  jsonSchema: Record<string, unknown>;
}

export interface ProviderGenerateInput {
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ProviderGenerateOutput {
  /**
   * The tool calls the model produced this step. A conforming provider MUST
   * return at least one — that is what "tool-only" means.
   */
  toolCalls: ToolCall[];
  usage?: Usage;
  /** The untouched provider response, for logging/debugging. */
  raw?: unknown;
}

/**
 * A backend adapter. Implement this to plug a new model API into the harness.
 *
 * Its one job: given the conversation and the available tools, return the next
 * tool calls. It must force the model to call tools (e.g. Anthropic
 * `tool_choice: { type: "any" }`) so no text turn slips through.
 */
export interface Provider {
  readonly name: string;
  /** Published per-1M-token prices for the model this provider calls, if known. */
  readonly pricing?: ModelPricing;
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateOutput>;
}

/** A new state value, or a function deriving it from the previous state. */
export type StateUpdater = AgentState | ((previous: AgentState) => AgentState);

/**
 * Replace the session's cognition state and notify subscribers (so any attached
 * interface re-renders). Pass a new value, or an updater for immutable updates.
 * The built-in cognition tools and your effect tools both use this.
 */
export type SetState = (update: StateUpdater) => void;

/** Why a `stop` was requested. See {@link TurnResult.stoppedBy}. */
export type StopReason = "completed" | "blocked" | "final-tool" | "max-turns" | "stop";

/** Context handed to every tool handler. */
export interface ToolContext {
  /** Read the current cognition state (live — reflects any `setState` made this step). */
  getState: () => AgentState;
  /** Update cognition state and trigger a re-render. */
  setState: SetState;
  /** The id of the tool call currently executing. */
  callId: string;
  /** Aborts when the current run's signal aborts. */
  signal: AbortSignal;
  /**
   * Ends the current run and yields control back to the caller. The session
   * stays alive — the caller can add goals or unblock and the conversation
   * continues. `reason` defaults to `"stop"`; `value` becomes {@link TurnResult.result}.
   */
  stop: (opts?: { reason?: StopReason; value?: unknown }) => void;
}

/**
 * A tool: a name, a description, an input schema, and a handler. Your tools are
 * effects (run a command, hit an API, read a file). The harness also provides
 * built-in cognition tools (`addMentalNote` / `setGoalCompleted` / `setBlockedBy`).
 */
export interface Tool {
  name: string;
  description: string;
  /** Zod schema — validates model input before the handler runs. */
  inputSchema: z.ZodType;
  /** Cached JSON Schema derived from {@link inputSchema}. */
  jsonSchema: Record<string, unknown>;
  /**
   * When true, this run ends as soon as the tool runs successfully and the
   * handler's return value becomes the result. Equivalent to `ctx.stop()`.
   */
  final: boolean;
  handler: (input: any, ctx: ToolContext) => unknown | Promise<unknown>;
}

/** Returned from {@link Hooks.onToolCall} to allow or veto a call. */
export type ToolDecision = void | { allow: true } | { allow: false; reason?: string };

/**
 * Lifecycle callbacks. All optional, all may be async. The harness awaits each,
 * so they can gate, mutate state, log, or stream to a UI.
 *
 * A "turn" is one model step: a single provider generation plus running the tool
 * calls it produced. One run (an `addGoals` / `unblock`) runs one or more turns.
 */
export interface Hooks {
  onTurnStart?(ctx: {
    turn: number;
    getState: () => AgentState;
    setState: SetState;
    messages: Message[];
  }): void | Promise<void>;
  /** Fires before a tool runs. Return `{ allow: false }` to veto it. */
  onToolCall?(ctx: {
    call: ToolCall;
    tool: Tool;
    getState: () => AgentState;
    setState: SetState;
  }): ToolDecision | Promise<ToolDecision>;
  onToolResult?(ctx: {
    call: ToolCall;
    result: ToolResult;
    getState: () => AgentState;
    setState: SetState;
  }): void | Promise<void>;
  onTurnEnd?(ctx: {
    turn: number;
    getState: () => AgentState;
    setState: SetState;
    messages: Message[];
  }): void | Promise<void>;
  onError?(ctx: {
    error: unknown;
    getState: () => AgentState;
    setState: SetState;
  }): void | Promise<void>;
  /**
   * Fires when the transcript is compacted to fit the context window — rebuilt
   * from the mental notes + a compact action ledger, dropping bulky tool I/O.
   */
  onCompact?(ctx: {
    reason: "threshold" | "overflow";
    /** Number of mental notes carried over. */
    notes: number;
    /** Number of actions in the ledger carried over. */
    actions: number;
    getState: () => AgentState;
    setState: SetState;
  }): void | Promise<void>;
}

/** Result of one run — the work between a host action (goals/unblock) and the agent yielding. */
export interface TurnResult {
  /** Why this run ended. */
  stoppedBy: StopReason;
  /** Value from the yielding tool / `ctx.stop()`. Undefined on `max-turns`. */
  result: unknown;
  /** Number of model steps taken during this run. */
  steps: number;
  /** Full session transcript so far (the model's working memory). */
  messages: Message[];
  /** Usage for this run. */
  usage: Usage;
}
