import { createCognition, initialAgentState, type AgentState } from "./cognition.js";
import { createDocTools, type DocMeta } from "./docs.js";
import { Session } from "./session.js";
import { createSkillTools, type SkillMeta } from "./skills.js";
import type { Hooks, Provider, Tool, TurnResult } from "./types.js";

export interface AgentConfig {
  /** The backend adapter (e.g. `anthropicProvider(...)`). */
  provider: Provider;
  /**
   * Your effect tools (run a command, read a file, hit an API). The harness adds
   * the built-in cognition tools (`addMentalNote` / `setGoalCompleted` /
   * `setBlockedBy`) automatically.
   */
  tools: Tool[];
  /**
   * Discovered skills (e.g. from `loadSkillsFromDir(".state-harness/skills")`).
   * The harness lists them in the system prompt and adds a `loadSkill` tool; the
   * agent runs each skill's scripts with your shell tool. Pass an empty array to
   * enable the skill protocol with none available yet (so it blocks for missing
   * ones). Omit to disable skills entirely.
   */
  skills?: SkillMeta[];
  /**
   * Discovered docs (e.g. from `loadDocsFromDir(".state-harness/docs")`). The
   * harness lists them by domain in the system prompt and adds a `loadDoc` tool;
   * the agent reads them for durable, cross-session knowledge and writes new ones
   * as it learns. Omit to disable the docs protocol.
   */
  docs?: DocMeta[];
  /** System prompt. The cognition contract and a tool-only preamble are appended. */
  system?: string;
  /** Lifecycle callbacks. */
  hooks?: Hooks;
  /**
   * Optional safety backstop on model steps per run. Default: unbounded — the
   * agent runs until it completes the goal or blocks. Set a number only to cap
   * runaway loops.
   */
  maxTurns?: number;
  /**
   * Input-token threshold above which the transcript is compacted (rebuilt from
   * the mental notes + action ledger, dropping bulky tool I/O) before the next
   * step. Default ~800k (≈80% of Opus 4.8's 1M window).
   */
  compactAtTokens?: number;
}

export interface SessionArgs {
  /** The goal this session pursues — set once, fixed for the session's life. */
  goal: string;
  /**
   * Optional starting cognition state to resume from (notes, blocked status). Its
   * `goal` overrides `goal` above. Omit for a fresh session.
   */
  state?: AgentState;
}

const TOOL_ONLY_PREAMBLE =
  "You operate exclusively through tool calls. You cannot send free-text " +
  "messages — every response must be one or more tool calls. You have ONLY the " +
  "tools provided and no other abilities. Never claim or imply you did something " +
  "you have no tool for — if a request needs a capability you weren't given, use " +
  "setBlockedBy to tell the user instead of pretending it's done.";

/**
 * A configured, reusable agent — defined by its effect tools. The harness gives
 * it a built-in cognition layer (the goal it pursues, structured mental notes it
 * thinks in, and a blocked signal). Each session pursues one goal; drive it with
 * `session.run()` and `session.unblock()`.
 */
export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly hooks?: Hooks;
  private readonly maxTurns?: number;
  private readonly compactAtTokens?: number;
  private readonly system: string;

  constructor(config: AgentConfig) {
    const cognition = createCognition();
    const skills = config.skills ? createSkillTools(config.skills) : null;
    const docs = config.docs ? createDocTools(config.docs) : null;
    this.provider = config.provider;
    this.tools = [
      ...cognition.tools,
      ...(skills?.tools ?? []),
      ...(docs?.tools ?? []),
      ...config.tools,
    ];
    this.hooks = config.hooks;
    this.maxTurns = config.maxTurns;
    this.compactAtTokens = config.compactAtTokens;
    this.system = [
      config.system,
      cognition.preamble,
      skills?.preamble,
      docs?.preamble,
      TOOL_ONLY_PREAMBLE,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** The full system prompt sent to the provider (your prompt + the cognition contract). */
  get systemPrompt(): string {
    return this.system;
  }

  /** Start a session for `goal` (a string, or `{ goal, state }` to resume). Drive it with `run()` / `unblock()`. */
  createSession(args: string | SessionArgs): Session {
    const { goal, state } = typeof args === "string" ? { goal: args, state: undefined } : args;
    return new Session({
      provider: this.provider,
      tools: this.tools,
      system: this.system,
      hooks: this.hooks,
      maxTurns: this.maxTurns,
      compactAtTokens: this.compactAtTokens,
      state: state ?? initialAgentState(goal),
    });
  }

  /** One-shot convenience: start a session for `goal` and run until it yields. */
  run(goal: string, opts: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    return this.createSession(goal).run(opts);
  }
}

/**
 * Create an agent from a set of effect tools. The harness adds the built-in
 * cognition tools (`addMentalNote` / `setGoalCompleted` / `setBlockedBy`) and the
 * prompt fragment that teaches the model the goal/note/block contract.
 */
export function createAgent(config: AgentConfig): Agent {
  return new Agent(config);
}
