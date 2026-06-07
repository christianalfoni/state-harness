import type { z } from "zod";
import { Session } from "./session.js";
import { createStateTools, type StateSchema } from "./state.js";
import type { Hooks, Provider, Tool, TurnResult } from "./types.js";

export interface AgentConfig<Schema extends StateSchema> {
  /** The backend adapter (e.g. `anthropicProvider(...)`). */
  provider: Provider;
  /**
   * The state schema (a Zod object). Its shape + `.default()`s define the initial
   * state, and the schema is described to the model in the system prompt. Mark
   * fields `.readonly()` to make them host-only (the model's `setState` refuses them).
   */
  state: Schema;
  /**
   * Your effect tools (run a command, read a file, hit an API). The harness adds
   * `getState` / `setState` / `yield` automatically.
   */
  tools: Tool<z.infer<Schema>>[];
  /** System prompt. The state description and a tool-only preamble are appended. */
  system?: string;
  /** Lifecycle callbacks. */
  hooks?: Hooks<z.infer<Schema>>;
  /** Max model steps per `send()`. Default 25. */
  maxTurns?: number;
}

export interface SessionArgs<State> {
  /** Override the initial state for this session (e.g. to resume one). */
  state?: State;
}

export interface RunArgs<State> extends SessionArgs<State> {
  signal?: AbortSignal;
}

interface ResolvedConfig<State> {
  provider: Provider;
  tools: Tool<State>[];
  state: State;
  system?: string;
  hooks?: Hooks<State>;
  maxTurns?: number;
}

const TOOL_ONLY_PREAMBLE =
  "You operate exclusively through tool calls. You cannot send free-text " +
  "messages — every response must be one or more tool calls. To say anything " +
  "to the user, or to hand control back to them, call the appropriate tool. " +
  "You have ONLY the tools provided and no other abilities. Never claim or imply " +
  "you did something you have no tool for — if a request needs a capability you " +
  "weren't given, use a tool to tell the user or ask how they'd like to proceed " +
  "instead of pretending it's done.";

/**
 * A configured, reusable agent — defined by its state schema and its tools. Spin
 * up a {@link Session} with `createSession` for multi-turn use, or `run` for a
 * one-shot exchange.
 */
export class Agent<State> {
  private readonly config: ResolvedConfig<State>;
  private readonly system: string;

  constructor(config: ResolvedConfig<State>) {
    this.config = config;
    this.system = config.system
      ? `${config.system}\n\n${TOOL_ONLY_PREAMBLE}`
      : TOOL_ONLY_PREAMBLE;
  }

  /** The full system prompt sent to the provider (state description + tool-only preamble). */
  get systemPrompt(): string {
    return this.system;
  }

  /** Start a multi-turn session. Call `session.send()` for each user message. */
  createSession(args?: SessionArgs<State>): Session<State> {
    return new Session<State>({
      provider: this.config.provider,
      tools: this.config.tools,
      system: this.system,
      hooks: this.config.hooks,
      maxTurns: this.config.maxTurns,
      state: args?.state ?? this.config.state,
    });
  }

  /** One-shot convenience: start a session and send a single message. */
  run(input: string, args?: RunArgs<State>): Promise<TurnResult> {
    return this.createSession({ state: args?.state }).send(input, { signal: args?.signal });
  }
}

/**
 * Create an agent from a state schema and a set of effect tools. The harness
 * derives the initial state, describes the schema to the model, and adds the
 * built-in `getState` / `setState` / `yield` tools.
 */
export function createAgent<Schema extends StateSchema>(
  config: AgentConfig<Schema>,
): Agent<z.infer<Schema>> {
  type State = z.infer<Schema>;
  const { initial, tools: stateTools, preamble } = createStateTools(config.state);
  const system = [config.system, preamble].filter(Boolean).join("\n\n");
  return new Agent<State>({
    provider: config.provider,
    tools: [...stateTools, ...config.tools],
    state: initial,
    system,
    hooks: config.hooks,
    maxTurns: config.maxTurns,
  });
}
