# state-harness

A **state-first agent harness**. An agent is defined by a **state schema** and a
set of **effect tools**. The harness gives the model `getState` / `setState` for
free — derived from your schema — so managing state isn't something you build per
app; it's the mechanism. The model never sends free-text messages: every step is
one or more tool calls, and your interface renders state.

The model is a reducer; the state is the model; your tools are the effects; the
UI is a pure projection. The conversation still exists, but only as the model's
working memory — not the user's interface.

The model-facing API still calls these "tools" (that's the wire reality); the
bundled provider drives the Anthropic Messages API with forced tool use, which is
what guarantees "tool calls only."

## Install

```bash
npm install state-harness
# set ANTHROPIC_API_KEY in your environment
```

## Quick start

```ts
import { z } from "zod";
import { createAgent, defineTool, anthropicProvider } from "state-harness";

// 1. Declare state as a schema. Defaults define the initial state; the schema
//    goes in the system prompt so the model knows its shape.
const StateSchema = z.object({
  notes: z.array(z.string()).default([]),
  answer: z.string().optional(),
});
type State = z.infer<typeof StateSchema>;

// 2. Bring effect tools (things that *do* something).
const getWeather = defineTool<z.ZodObject<{ city: z.ZodString }>, State>({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  input: z.object({ city: z.string() }),
  handler: ({ city }) => ({ city, tempC: 14 }),
});

const agent = createAgent({
  provider: anthropicProvider({ model: "claude-opus-4-8" }),
  state: StateSchema,        // the model gets getState/setState for this
  tools: [getWeather],       // your effects
  system: "Look it up, then setState the `answer` field (setState ends your turn).",
});

const session = agent.createSession();
await session.send("Weather in Oslo — should I pack a coat?");
console.log(session.getState().answer);
```

Run the full example:

```bash
ANTHROPIC_API_KEY=sk-... npm run example
```

## Concepts

### State is a schema

You pass `state: ZodObject` to `createAgent`. From it the harness:

- derives the **initial state** via `schema.parse({})` (so every field needs a
  `.default()` or be optional);
- puts the **schema + initial values in the system prompt** once (static, so it's
  cached — not re-injected every turn);
- auto-provides two built-in tools the model uses to read and write state:

| Tool | What it does |
| --- | --- |
| `getState(key?)` | Read the whole state, or one field. Does **not** end the turn — the model calls this to refresh (e.g. to see something *you* changed). |
| `setState(patch)` | Patch writable fields (a partial of the schema) **and hand control back** — `setState` *ends the turn*. Read-only fields aren't in its schema, so they can't be set. |

So there's no bespoke "tasks" / "set_changes" tool, and no separate `yield`:
`setState` is the model's "commit and hand back" verb. A turn is *read/act
freely → `setState` once to commit and yield*. Effect tools and `getState` don't
end the turn; only `setState` (or `ctx.stop()` in your own tools) does.

> One consequence: the model can't update state and *keep working* in the same
> turn — every `setState` hands back. Live intra-turn progress should come from an
> **effect** writing state (`ctx.setState`, which doesn't yield). This fits the
> "state reflects reality, not narration" stance, but makes the harness aimed at
> interactive, turn-based agents rather than long autonomous accumulation.

### Read-only fields

Mark a field `.readonly()` and the model's `setState` tool refuses it — those are
the **host's** to set. The host always can: `session.setState(...)` (e.g. from
your CLI) and `ctx.setState(...)` (from your effect tools) are not gated. This is
how you express "the user owns this, the model can only read it":

```ts
const StateSchema = z.object({
  changes: z.array(Change).default([]),                   // model writes these
  approvedFiles: z.array(z.string()).default([]).readonly(), // host-only
});
// model setState({ approvedFiles: [...] })  → silently stripped (not in its schema)
// session.setState(s => ({ ...s, approvedFiles: [...] })) → allowed (host)
```

### Tools (effects)

A tool is a name, a description, a [Zod](https://zod.dev) input schema, and a
handler. Build them with `defineTool`. The handler gets a `ctx`:

| Field | Purpose |
| --- | --- |
| `ctx.getState()` | Read current state. |
| `ctx.setState` | Update state (host-level — not subject to `readonly`). |
| `ctx.callId` | The current tool-call id. |
| `ctx.signal` | Aborts with the send's `AbortSignal`. |
| `ctx.stop(v)` | Hand control back early (like `setState` does). |

### Sessions are reactive

A `Session` is a multi-turn conversation *and* a reactive store. Create it once,
`send()` per user turn. Subscribe to drive a UI — the listener gets the current
state **and** a log of every tool call the model made:

```ts
const session = agent.createSession();
session.subscribe((state, toolCalls) => render(state));

session.getState();      // current state
session.getToolCalls();  // the tool-call log
session.setState(...);   // host write (ungated)
```

It notifies on every state change *and* every tool call. `getState`/`subscribe`
are stable references, so they also plug into React's `useSyncExternalStore`.

### Lifecycle hooks

Optional `hooks` on `createAgent` — `onTurnStart` / `onToolCall` (gate, return
`{ allow: false }`) / `onToolResult` / `onTurnEnd` / `onError`, each carrying
`getState` and `setState`.

## Providers

```ts
interface Provider {
  readonly name: string;
  generate(input: {
    system?: string;
    messages: Message[];   // the model's working memory
    tools: ToolSpec[];     // name, description, JSON Schema
    signal?: AbortSignal;
  }): Promise<{ toolCalls: ToolCall[]; usage?: Usage; raw?: unknown }>;
}
```

The provider must force the model to act (so it never returns an empty
`toolCalls`). The bundled `anthropicProvider` uses `tool_choice: { type: "any" }`.

## Demo: a coding agent with approval

`demo/` works **change-by-change with approval**, and shows the whole model:

- `state` is `{ changes, approvedFiles (readonly), status (readonly) }`.
- The agent proposes via `setState({ changes: [...] })` — which hands back to wait.
- `write_file` / `edit` are **hard-gated**: they error unless the file is in
  `approvedFiles`. The model can't approve its own work — `approvedFiles` is
  readonly to it.
- You approve with **`/approve`**, a CLI command that writes `approvedFiles`
  directly via `session.setState` (the host path), then wakes the agent.

```bash
ANTHROPIC_API_KEY=sk-... npm run demo -- "add a /health endpoint to server.js"
```

```
  Changes
    ○ server.js — add a GET /health route   — needs approval
        add a GET /health route returning { ok: true }

  1 change awaits approval — type /approve to approve, or describe what to change.

you › /approve
```

The UI is a pure component over `DemoState`; `session.subscribe` re-renders it.
There's no app-specific state tool — the agent manages `changes` through the
built-in `setState`, and approval is just a readonly field. See
[demo/tools.ts](demo/tools.ts) (schema + effect tools), [demo/cli.tsx](demo/cli.tsx)
(wiring + `/approve`), and [demo/app.tsx](demo/app.tsx) (the Ink UI).

> **Note:** `bash` is not sandboxed — it runs with the workspace as cwd but a
> command can reach outside it. It's a local dev tool on your own machine.

## API surface

| Export | What it is |
| --- | --- |
| `createAgent` / `Agent` | Define an agent by its `state` schema + effect `tools`. |
| `agent.createSession()` | Start a multi-turn reactive `Session`. |
| `agent.run()` | One-shot convenience. |
| `defineTool` | Build a typed effect tool from a Zod schema. |
| `createStateTools` | The schema → `getState`/`setState` builder (used internally; exported for custom setups). |
| `thinkTool` | A ready-made private reasoning tool. |
| `anthropicProvider` | The Anthropic Messages API adapter (forced tool use). |
| `Tool`, `ToolContext`, … | Types for building tools and adapters. |

## License

MIT
