import { COGNITION_TOOL_NAMES, type AgentState } from "./cognition.js";
import { estimateCost } from "./pricing.js";
import type {
  Hooks,
  Message,
  Provider,
  ProviderGenerateOutput,
  SetState,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
  TurnResult,
  Usage,
} from "./types.js";

/** One executed effect call, kept as a compact line so it survives compaction. */
interface ActionEntry {
  tool: string;
  summary: string;
  ok: boolean;
}

/** Default token threshold above which the transcript is compacted (≈80% of Opus 4.8's 1M window). */
const DEFAULT_COMPACT_AT_TOKENS = 800_000;

/** A subscriber to session changes: receives the current state and the tool-call log. */
export type SessionListener = (state: AgentState, toolCalls: ToolCall[]) => void;

export interface SessionConfig {
  provider: Provider;
  tools: Tool[];
  system?: string;
  hooks?: Hooks;
  /**
   * Optional safety backstop on model steps per run. Default: unbounded — the
   * agent runs until it completes the goal or blocks. Set a number only to cap
   * runaway loops; hitting it stops the run with `stoppedBy: "max-turns"`.
   */
  maxTurns?: number;
  /**
   * When the last generation's input tokens exceed this, the transcript is
   * compacted before the next step — rebuilt from the mental notes + action
   * ledger, dropping bulky tool I/O. Default ~800k (≈80% of Opus 4.8's 1M
   * window). Lower it for a smaller-window model, or for cost/latency.
   */
  compactAtTokens?: number;
  /** Initial cognition state — carries the session's goal. */
  state: AgentState;
}

export interface RunOptions {
  signal?: AbortSignal;
}

interface Stop {
  reason: StopReason;
  value: unknown;
}

/**
 * A session pursuing one goal, and a reactive container for its cognition state.
 * Drive it: `run()` to start pursuing the goal, `unblock(...)` to resume it when
 * it's stuck. Both run the agent until it yields (the goal is complete, or it
 * declared itself blocked). Tools update state through `setState`; subscribers get
 * the current state plus a growing log of every tool call the model made, so the
 * view re-renders as the agent thinks and works.
 */
export class Session {
  private readonly provider: Provider;
  private readonly tools: Map<string, Tool>;
  private readonly specs: ToolSpec[];
  private readonly system?: string;
  private readonly hooks: Hooks;
  private readonly maxTurns: number;

  /** The full normalized transcript (the model's working memory), growing across runs. */
  readonly messages: Message[] = [];
  /** Cumulative usage across every run. */
  readonly usage: Usage = {};

  private currentState: AgentState;
  private toolLog: ToolCall[] = [];
  private readonly listeners = new Set<SessionListener>();
  private step = 0;
  private started = false;

  // Append-only record of executed effect calls — the durable "what I've done",
  // independent of `messages`, so compaction can carry it without duplicating.
  private readonly ledger: ActionEntry[] = [];
  private readonly compactAtTokens: number;
  private lastInputTokens = 0;

  constructor(config: SessionConfig) {
    this.provider = config.provider;
    this.tools = new Map(config.tools.map((t) => [t.name, t]));
    this.specs = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: t.jsonSchema,
    }));
    this.system = config.system;
    this.hooks = config.hooks ?? {};
    // Unbounded by default: the agent runs until it completes the goal or blocks.
    // `maxTurns` is only a safety backstop if a host explicitly sets one.
    this.maxTurns = config.maxTurns ?? Infinity;
    this.compactAtTokens = config.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS;
    this.currentState = config.state;
  }

  /** Stable snapshot getter for the current cognition state. */
  readonly getState = (): AgentState => this.currentState;

  /** Stable snapshot getter for the tool-call log (every tool call made so far). */
  readonly getToolCalls = (): ToolCall[] => this.toolLog;

  /**
   * Estimated cumulative cost (US$) of the session, from {@link usage} and the
   * provider's published pricing. `undefined` if the provider declares no pricing.
   */
  readonly estimatedCost = (): number | undefined =>
    this.provider.pricing ? estimateCost(this.usage, this.provider.pricing) : undefined;

  /**
   * Subscribe to changes. The listener is called with the current state and the
   * tool-call log on every state update and every tool call. Returns an
   * unsubscribe function.
   */
  readonly subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replace state (value or updater) and notify subscribers. */
  readonly setState: SetState = (update) => {
    const next =
      typeof update === "function"
        ? (update as (previous: AgentState) => AgentState)(this.currentState)
        : update;
    if (Object.is(next, this.currentState)) return;
    this.currentState = next;
    this.notify();
  };

  private notify(): void {
    for (const listener of this.listeners) listener(this.currentState, this.toolLog);
  }

  /**
   * Start pursuing the session's goal and run until it yields — the goal is
   * complete, the agent declares itself blocked, a `final` tool runs, or
   * `maxTurns` elapse. The goal is announced in the transcript on the first call;
   * calling `run()` again just continues the loop (e.g. after `maxTurns`).
   */
  async run(opts: RunOptions = {}): Promise<TurnResult> {
    if (!this.started) {
      this.started = true;
      this.messages.push({
        role: "user",
        text:
          `Your goal:\n${this.currentState.goal.body}\n\n` +
          "Pursue it. Think with addMentalNote, finish with setGoalCompleted, or setBlockedBy " +
          "if you need me.",
      });
    }
    return this.loop(opts.signal);
  }

  /**
   * Resume a blocked agent: clear `blockedBy`, deliver your reply (the info,
   * decision, or approval it asked for) into the transcript, and run until it
   * yields again. Throws if the agent isn't currently blocked.
   */
  async unblock(message: string, opts: RunOptions = {}): Promise<TurnResult> {
    if (this.currentState.blockedBy === null) {
      throw new Error("The agent is not blocked; nothing to unblock.");
    }
    this.setState((s) => ({ ...s, blockedBy: null }));
    this.messages.push({ role: "user", text: message });
    return this.loop(opts.signal);
  }

  /** The core agent loop: generate → run tools → repeat until something yields. */
  private async loop(signal: AbortSignal | undefined): Promise<TurnResult> {
    const runUsage: Usage = {};
    let stop: Stop | null = null;
    let steps = 0;

    try {
      while (!stop) {
        if (steps >= this.maxTurns) {
          stop = { reason: "max-turns", value: undefined };
          break;
        }
        steps++;
        this.step++;
        signal?.throwIfAborted();

        // Proactive: if the last request was near the window, compact before this one.
        if (this.lastInputTokens > this.compactAtTokens) await this.maybeCompact("threshold");

        await this.hooks.onTurnStart?.({
          turn: this.step,
          getState: this.getState,
          setState: this.setState,
          messages: this.messages,
        });

        const out = await this.generate(signal);
        this.lastInputTokens = out.usage?.inputTokens ?? this.lastInputTokens;
        addUsage(runUsage, out.usage);
        addUsage(this.usage, out.usage);

        if (out.toolCalls.length === 0) {
          throw new Error(
            `Provider "${this.provider.name}" returned no tool calls. A provider must ` +
              `force tool use (e.g. tool_choice: "any").`,
          );
        }

        this.messages.push({ role: "assistant", toolCalls: out.toolCalls });

        const results: ToolResult[] = [];
        for (const call of out.toolCalls) {
          const { result, stopRequest } = await this.runTool(call, signal);
          results.push(result);
          await this.hooks.onToolResult?.({
            call,
            result,
            getState: this.getState,
            setState: this.setState,
          });
          if (stopRequest && !stop) stop = stopRequest;
        }

        this.messages.push({ role: "tool", results });
        await this.hooks.onTurnEnd?.({
          turn: this.step,
          getState: this.getState,
          setState: this.setState,
          messages: this.messages,
        });
      }
    } catch (error) {
      await this.hooks.onError?.({ error, getState: this.getState, setState: this.setState });
      throw error;
    }

    return {
      stoppedBy: stop.reason,
      result: stop.value,
      steps,
      messages: this.messages,
      usage: runUsage,
    };
  }

  /** One provider generation, with a reactive compaction-and-retry if the prompt overflows. */
  private async generate(signal: AbortSignal | undefined): Promise<ProviderGenerateOutput> {
    const call = () =>
      this.provider.generate({
        system: this.system,
        messages: this.messages,
        tools: this.specs,
        signal,
      });
    try {
      return await call();
    } catch (error) {
      // Backstop: if we blew the context window, compact and retry exactly once.
      if (isContextOverflow(error) && (await this.maybeCompact("overflow"))) {
        return call();
      }
      throw error;
    }
  }

  /**
   * Rebuild the transcript from the durable cognition state — the mental notes
   * (replayed as the agent's own `addMentalNote` calls) plus the action ledger —
   * dropping bulky tool I/O. Since notes/ledger are append-only and we rebuild
   * from them (never append to an already-compacted transcript), nothing is
   * duplicated across repeated compactions. Returns false if there's nothing to carry.
   */
  private async maybeCompact(reason: "threshold" | "overflow"): Promise<boolean> {
    const { notes, goal } = this.currentState;
    if (notes.length === 0 && this.ledger.length === 0) return false;

    const rebuilt: Message[] = [{ role: "user", text: `Your goal:\n${goal.body}` }];

    // Replay the notes as one batch of addMentalNote calls — the model sees them
    // as its own prior reasoning. Ids and cross-refs are preserved verbatim.
    if (notes.length > 0) {
      const toolCalls: ToolCall[] = notes.map((note, i) => {
        const { id: _id, ...entry } = note;
        return { id: `compact-${i}`, name: "addMentalNote", input: { entry } };
      });
      const results: ToolResult[] = notes.map((note, i) => ({
        toolCallId: `compact-${i}`,
        content: JSON.stringify({ id: note.id }),
      }));
      rebuilt.push({ role: "assistant", toolCalls }, { role: "tool", results });
    }

    rebuilt.push({ role: "user", text: this.compactionNotice() });

    this.messages.length = 0;
    this.messages.push(...rebuilt);
    this.lastInputTokens = 0;

    await this.hooks.onCompact?.({
      reason,
      notes: notes.length,
      actions: this.ledger.length,
      getState: this.getState,
      setState: this.setState,
    });
    return true;
  }

  /** The orientation message appended after a compaction — the action ledger + how to continue. */
  private compactionNotice(): string {
    const ledger = this.ledger.length
      ? "\n\nActions you've already taken (don't redo them):\n" +
        this.ledger
          .map((a) => `- ${a.tool}${a.summary ? ` ${a.summary}` : ""}${a.ok ? "" : " (failed)"}`)
          .join("\n")
      : "";
    return (
      "[Your context was compacted to fit the window. The notes above are your full reasoning " +
      "so far.]" +
      ledger +
      "\n\nThe files on disk reflect this work — re-read any file whose current contents you need. " +
      "Continue toward the goal."
    );
  }

  /** Record an executed effect call in the ledger (cognition tools are not "actions"). */
  private recordAction(call: ToolCall, ok: boolean): void {
    if (COGNITION_TOOL_NAMES.has(call.name)) return;
    this.ledger.push({ tool: call.name, summary: summarizeToolInput(call.input), ok });
  }

  private async runTool(
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): Promise<{ result: ToolResult; stopRequest: Stop | null }> {
    // Record the tool call and notify, so subscribers see a live log.
    this.toolLog = [...this.toolLog, call];
    this.notify();

    const tool = this.tools.get(call.name);
    if (!tool) {
      return { result: errorResult(call, `Unknown tool: ${call.name}`), stopRequest: null };
    }

    const decision = await this.hooks.onToolCall?.({
      call,
      tool,
      getState: this.getState,
      setState: this.setState,
    });
    if (decision && decision.allow === false) {
      return {
        result: errorResult(call, decision.reason ?? "Tool call denied."),
        stopRequest: null,
      };
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        result: errorResult(call, `Invalid input: ${parsed.error.message}`),
        stopRequest: null,
      };
    }

    let stopRequest: Stop | null = null;
    const ctx: ToolContext = {
      getState: this.getState,
      setState: this.setState,
      callId: call.id,
      signal: signal ?? neverAbort,
      stop: (opts = {}) => {
        stopRequest = { reason: opts.reason ?? "stop", value: opts.value };
      },
    };

    try {
      const value = await tool.handler(parsed.data, ctx);
      if (tool.final && !stopRequest) stopRequest = { reason: "final-tool", value };
      this.recordAction(call, true);
      return { result: okResult(call, value), stopRequest };
    } catch (error) {
      // Tool failures are reported back to the model rather than aborting the
      // run — the model can read the error and adapt.
      this.recordAction(call, false);
      return { result: errorResult(call, errorMessage(error)), stopRequest: null };
    }
  }
}

function okResult(call: ToolCall, value: unknown): ToolResult {
  return { toolCallId: call.id, content: stringify(value) };
}

function errorResult(call: ToolCall, message: string): ToolResult {
  return { toolCallId: call.id, content: message, isError: true };
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A short label for an effect call's input (the path it touched, the command it ran, …). */
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "command", "file"]) {
    const v = obj[key];
    if (typeof v === "string") return clip(v);
  }
  for (const v of Object.values(obj)) if (typeof v === "string") return clip(v);
  return "";
}

function clip(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Best-effort detection of a context-window-overflow error from a provider. */
function isContextOverflow(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("prompt is too long") ||
    msg.includes("maximum context") ||
    msg.includes("context length") ||
    msg.includes("context window") ||
    (msg.includes("token") && msg.includes("exceed"))
  );
}

function addUsage(into: Usage, from: Usage | undefined): void {
  if (!from) return;
  for (const key of Object.keys(from) as (keyof Usage)[]) {
    const v = from[key];
    if (typeof v === "number") into[key] = (into[key] ?? 0) + v;
  }
}

const neverAbort = new AbortController().signal;
