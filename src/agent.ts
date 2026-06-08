import type { z } from "zod";
import { Session } from "./session.js";
import { createStateTools, type StateSchema } from "./state.js";
import type { Hooks, Provider, Tool, TurnResult } from "./types.js";

export interface AgentConfig<Schema extends StateSchema> {
  /** The backend adapter (e.g. `anthropicProvider(...)`). */
  provider: Provider;
  /**
   * The state schema (a Zod object) — the *shape* of the agent's state, described
   * to the model in the system prompt. Mark fields `.readonly()` to make them
   * host-only (the model's `setState` refuses them). The *initial* values are
   * passed per session at `createSession`.
   */
  state: Schema;
  /**
   * Your effect tools (run a command, read a file, hit an API). The harness adds
   * `getState` / `setState` automatically.
   */
  tools: Tool<z.infer<Schema>>[];
  /** System prompt. The state description and a tool-only preamble are appended. */
  system?: string;
  /** Lifecycle callbacks. */
  hooks?: Hooks<z.infer<Schema>>;
  /** Max model steps per `send()`. Default 25. */
  maxTurns?: number;
}

export interface SessionArgs<Schema extends StateSchema> {
  /**
   * The complete initial state for this session. The schema is *shape only* (no
   * defaults), so the session supplies every value — a fresh start, or a state
   * you're resuming. It's validated against the schema.
   */
  state: z.input<Schema>;
}

export interface RunArgs<Schema extends StateSchema> extends SessionArgs<Schema> {
  signal?: AbortSignal;
}

interface ResolvedConfig<Schema extends StateSchema> {
  provider: Provider;
  schema: Schema;
  tools: Tool<z.infer<Schema>>[];
  system?: string;
  hooks?: Hooks<z.infer<Schema>>;
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
 * A configured, reusable agent — defined by its state *schema* and its tools.
 * Initial state is supplied per session via `createSession({ state })`.
 */
export class Agent<Schema extends StateSchema> {
  private readonly config: ResolvedConfig<Schema>;
  private readonly system: string;

  constructor(config: ResolvedConfig<Schema>) {
    this.config = config;
    this.system = config.system
      ? `${config.system}\n\n${TOOL_ONLY_PREAMBLE}`
      : TOOL_ONLY_PREAMBLE;
  }

  /** The full system prompt sent to the provider (state description + tool-only preamble). */
  get systemPrompt(): string {
    return this.system;
  }

  /** Start a multi-turn session with its complete initial state. Call `session.send()` per user message. */
  createSession(args: SessionArgs<Schema>): Session<z.infer<Schema>> {
    // Validate the supplied state against the schema.
    const state = this.config.schema.parse(args.state) as z.infer<Schema>;
    return new Session<z.infer<Schema>>({
      provider: this.config.provider,
      tools: this.config.tools,
      system: this.system,
      hooks: this.config.hooks,
      maxTurns: this.config.maxTurns,
      state,
    });
  }

  /** One-shot convenience: start a session and send a single message. */
  run(input: string, args: RunArgs<Schema>): Promise<TurnResult> {
    return this.createSession({ state: args.state }).send(input, { signal: args.signal });
  }
}

/**
 * Create an agent from a state schema and a set of effect tools. The harness
 * describes the schema to the model and adds the built-in `getState` / `setState`
 * tools. Provide initial state per session with `createSession({ state })`.
 */
export function createAgent<Schema extends StateSchema>(
  config: AgentConfig<Schema>,
): Agent<Schema> {
  const { tools: stateTools, preamble } = createStateTools(config.state);
  const system = [config.system, preamble].filter(Boolean).join("\n\n");
  return new Agent<Schema>({
    provider: config.provider,
    schema: config.state,
    tools: [...stateTools, ...config.tools],
    system,
    hooks: config.hooks,
    maxTurns: config.maxTurns,
  });
}
