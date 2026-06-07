import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defineTool } from "./tool.js";
import type { ToolDefinition } from "./tool.js";
import type { Tool } from "./types.js";

/** The state is a Zod object: its shape + defaults define the initial state. */
export type StateSchema = z.ZodObject<z.ZodRawShape>;

export interface StateTools<State> {
  /** Initial state, derived from the schema's defaults via `schema.parse({})`. */
  initial: State;
  /** Top-level keys marked `.readonly()` — the model's `setState` refuses these. */
  readonlyKeys: Set<string>;
  /** The built-in tools: `getState`, `setState`, `yield`. */
  tools: Tool<State>[];
  /** A system-prompt fragment describing the state schema, initial values, and tools. */
  preamble: string;
}

/**
 * Turn a state schema into the harness's built-in state machinery: the initial
 * state, the `getState` / `setState` / `yield` tools, and the prompt fragment
 * that teaches the model about its state. `setState` is schema-validated and
 * refuses `readonly` fields (those are the host's / user's to set).
 */
export function createStateTools<Schema extends StateSchema>(
  schema: Schema,
): StateTools<z.infer<Schema>> {
  type State = z.infer<Schema>;
  const initial = schema.parse({}) as State;
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const readonlyKeys = new Set(
    Object.keys(shape).filter((key) => shape[key] instanceof z.ZodReadonly),
  );

  // The model may only set non-readonly fields; readonly ones aren't even in the
  // setState input schema (and Zod strips anything extra), so the gate is the shape.
  const writableShape: z.ZodRawShape = {};
  for (const [key, field] of Object.entries(shape)) {
    if (!(field instanceof z.ZodReadonly)) writableShape[key] = field;
  }

  const tool = <S extends z.ZodType>(def: ToolDefinition<S, State>) => defineTool<S, State>(def);

  const getState = tool({
    name: "getState",
    description:
      "Read the current state. Pass `key` to read one field, or omit it for the whole " +
      "object. Use this to see fields the user/system controls, or to refresh after the " +
      "state may have changed.",
    input: z.object({ key: z.string().optional() }),
    handler: ({ key }, ctx) => {
      const state = ctx.getState() as Record<string, unknown>;
      if (key === undefined) return state;
      if (!(key in shape)) throw new Error(`Unknown state key: "${key}".`);
      return state[key];
    },
  });

  const readonlyList = readonlyKeys.size ? [...readonlyKeys].join(", ") : "none";

  const setState = tool({
    name: "setState",
    description:
      "Commit a state update AND hand control back to the user — calling this ENDS your " +
      "turn. So do all your reads (getState) and effect tool calls first, then call setState " +
      "once when you're ready to hand back (you've finished, or you're waiting on the user — " +
      "e.g. for approval). Provide any writable fields to set them (pass each field's COMPLETE " +
      `value — it replaces the old one). Read-only fields (${readonlyList}) are set by the ` +
      "user/system, not here.",
    input: z.object(writableShape).partial(),
    handler: (input, ctx) => {
      const raw = input as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(raw)) {
        if (raw[key] !== undefined) patch[key] = raw[key];
      }
      if (Object.keys(patch).length > 0) {
        ctx.setState((s) => ({ ...(s as Record<string, unknown>), ...patch }) as State);
      }
      // setState always yields — it's the model's "commit and hand back" verb.
      ctx.stop();
      return { ok: true };
    },
  });

  const jsonSchema = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;

  const preamble =
    "You have a STATE object that you read and write through tools — it is the source of " +
    "truth and what the user sees.\n\nState schema:\n" +
    JSON.stringify(jsonSchema) +
    "\n\nInitial state:\n" +
    JSON.stringify(initial) +
    "\n\nRead it with getState (optionally a key) — this does not end your turn. Commit " +
    "changes with setState, which applies your update AND hands control back to the user " +
    "(it ENDS your turn). So do all your getState/effect calls first, then setState once " +
    "when you're ready to hand back. " +
    (readonlyKeys.size
      ? `The read-only fields [${readonlyList}] are controlled by the user/system, not you — ` +
        "call getState to see their current values (e.g. after the user acts on something). "
      : "") +
    "The state can change between your turns, so call getState to refresh when it matters.";

  return { initial, readonlyKeys, tools: [getState, setState], preamble };
}
