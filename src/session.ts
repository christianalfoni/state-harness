import type {
  Hooks,
  Message,
  Provider,
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

/** A subscriber to session changes: receives the current state and the tool-call log. */
export type SessionListener<State> = (state: State, toolCalls: ToolCall[]) => void;

export interface SessionConfig<State> {
  provider: Provider;
  tools: Tool<State>[];
  system?: string;
  hooks?: Hooks<State>;
  /** Max model steps per `send()`, to bound runaway loops. Default 25. */
  maxTurns?: number;
  /** Initial state, persisted for the life of the session. */
  state: State;
}

export interface SendOptions {
  signal?: AbortSignal;
}

interface Stop {
  reason: StopReason;
  value: unknown;
}

/**
 * A multi-turn session, and a reactive container for its state. Construct once,
 * then call `send()` per user message. Tools and hooks update state via
 * `setState`; subscribers get the current state plus a growing log of every tool
 * call the model made, so the view re-renders as the agent works. The session
 * *is* the stateful interface.
 */
export class Session<State> {
  private readonly provider: Provider;
  private readonly tools: Map<string, Tool<State>>;
  private readonly specs: ToolSpec[];
  private readonly system?: string;
  private readonly hooks: Hooks<State>;
  private readonly maxTurns: number;

  /** The full normalized transcript (the model's working memory), growing across sends. */
  readonly messages: Message[] = [];
  /** Cumulative usage across every send. */
  readonly usage: Usage = {};

  private currentState: State;
  private toolLog: ToolCall[] = [];
  private readonly listeners = new Set<SessionListener<State>>();
  private step = 0;

  constructor(config: SessionConfig<State>) {
    this.provider = config.provider;
    this.tools = new Map(config.tools.map((t) => [t.name, t]));
    this.specs = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: t.jsonSchema,
    }));
    this.system = config.system;
    this.hooks = config.hooks ?? {};
    this.maxTurns = config.maxTurns ?? 25;
    this.currentState = config.state;
  }

  /** Stable snapshot getter for the current state. */
  readonly getState = (): State => this.currentState;

  /** Stable snapshot getter for the tool-call log (every tool call made so far). */
  readonly getToolCalls = (): ToolCall[] => this.toolLog;

  /**
   * Subscribe to changes. The listener is called with the current state and the
   * tool-call log on every state update and every tool call. Returns an
   * unsubscribe function.
   */
  readonly subscribe = (listener: SessionListener<State>): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replace state (value or updater) and notify subscribers. Not subject to `readonly`. */
  readonly setState: SetState<State> = (update) => {
    const next =
      typeof update === "function"
        ? (update as (previous: State) => State)(this.currentState)
        : update;
    if (Object.is(next, this.currentState)) return;
    this.currentState = next;
    this.notify();
  };

  private notify(): void {
    for (const listener of this.listeners) listener(this.currentState, this.toolLog);
  }

  /**
   * Deliver a user message and run the agent until it yields control back.
   * Returns once a tool calls `ctx.stop()` (e.g. the built-in `yield`) / a
   * `final` tool runs, or `maxTurns` model steps elapse without yielding.
   */
  async send(input: string, opts: SendOptions = {}): Promise<TurnResult> {
    const { signal } = opts;
    const sendUsage: Usage = {};
    this.messages.push({ role: "user", text: input });

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
        await this.hooks.onTurnStart?.({
          turn: this.step,
          getState: this.getState,
          setState: this.setState,
          messages: this.messages,
        });

        const out = await this.provider.generate({
          system: this.system,
          messages: this.messages,
          tools: this.specs,
          signal,
        });
        addUsage(sendUsage, out.usage);
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
      usage: sendUsage,
    };
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
    const ctx: ToolContext<State> = {
      getState: this.getState,
      setState: this.setState,
      callId: call.id,
      signal: signal ?? neverAbort,
      stop: (value?: unknown) => {
        stopRequest = { reason: "stop", value };
      },
    };

    try {
      const value = await tool.handler(parsed.data, ctx);
      if (tool.final) stopRequest = { reason: "final-tool", value };
      return { result: okResult(call, value), stopRequest };
    } catch (error) {
      // Tool failures are reported back to the model rather than aborting the
      // session — the model can read the error and adapt.
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

function addUsage(into: Usage, from: Usage | undefined): void {
  if (!from) return;
  for (const key of Object.keys(from) as (keyof Usage)[]) {
    const v = from[key];
    if (typeof v === "number") into[key] = (into[key] ?? 0) + v;
  }
}

const neverAbort = new AbortController().signal;
