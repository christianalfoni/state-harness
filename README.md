# state-harness

A **goal-driven agent harness**. You bring a set of **effect tools**; the harness
gives the agent a built-in **cognition layer**. A **session is a goal**: you
create it with one goal it can't change, it thinks in structured **mental notes**,
and it either **completes** the goal or declares itself **blocked**. It never
talks to you in prose.

> **A session is a goal. The agent thinks out loud — but structured — and either finishes it or asks you to unblock it.**

## Thinking is structured, not prose

Under forced tool use the model has no free-text channel. Rather than hand it a
freeform scratchpad, the harness gives it **`addMentalNote`** — a single tool
whose input is a discriminated union of reasoning *kinds*:

| Kind | Shape |
| --- | --- |
| `finding` | `body`, `evidence` (tool-call / note ids) |
| `hypothesis` | `body`, `impact` (how bad if wrong), `verifyBy` (the check that settles it) |
| `decision` | `body`, `basedOn` (note ids), `alternatives` (rejected, with reasons) |
| `constraint` | `body`, `source` |
| `plan` | `steps[]` with `todo` / `doing` / `done` / `dropped` |
| `revision` | `supersedes` (note id), `body` |
| `skillGap` | `need` (what a missing skill must do), `reason` (why) |
| `reference` | `topic`, `location` (path/URL), `scope` (local/web), `summary?` |

So the model still gets room to produce "thinking tokens" — but every thought
lands in a typed slot you can render, inspect, and reference. A decision records
what it rests on and what it rejected; a hypothesis records how bad it'd be if
wrong and the check that would settle it; a revision points at the note it
corrects. The reasoning becomes a
**graph of structured entries**, not a wall of text to parse.

## The loop: one goal in, blocked or done out

A session's whole observable surface is a fixed **cognition state**:

```ts
interface AgentState {
  goal: Goal;               // { body, status: "active" | "completed", summary }
  notes: StoredEntry[];     // the structured thinking log, each with an id
  blockedBy: string | null; // why it handed control back, or null
}
```

You create a session with **one goal**; `run()` it. The agent thinks
(`addMentalNote`), acts (your effect tools), and resolves the goal one of two
ways:

- **`setGoalCompleted(summary, verification)`** — done. Ends the run; the summary
  is its report and `verification` states how it confirmed the behavior actually
  works. It may only complete after **validating** — see below.
- **`setBlockedBy(reason)`** — something *outside its control* genuinely stops it
  (information it can't obtain, access it lacks, an action only you can take, or no
  way to validate the result). Not for asking permission or confirming an approach
  it could just carry out. This ends the run; you read `blockedBy`, then
  **`unblock(reply)`** to resume it.

The goal is *yours* — the model can't invent or change it, only complete it or
block on it. `addMentalNote` and your effect tools never end a turn; only
completing the goal or blocking does.

### Validation-first

A goal isn't done because the code compiles — it's done when it's proven from the
**user's perspective**: the agent exercises the result the way its actual user
would (load the UI and click it, run the command, hit the endpoint), never a proxy
like a build, a lint, or a unit test of internal code. If it lacks the means to do
that, it **builds the capability itself** (see [Skills](#skills)) rather than
substituting a weaker check — and only **`setBlockedBy`s** if that's genuinely
beyond it (it needs access, a credential, or an action only you can take). And
`setGoalCompleted` *requires* a `verification` describing what it actually
exercised and observed, so "never really checked" can't pass silently.

## Install

```bash
npm install state-harness
# set ANTHROPIC_API_KEY in your environment
```

## Quick start

```ts
import { z } from "zod";
import { createAgent, defineTool, anthropicProvider } from "state-harness";

// Bring effect tools (things that *do* something). No state schema.
const getWeather = defineTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  input: z.object({ city: z.string() }),
  handler: ({ city }) => ({ city, tempC: 14 }),
});

const agent = createAgent({
  provider: anthropicProvider({ model: "claude-opus-4-8" }),
  tools: [getWeather],
  system: "Concise travel assistant. Reason in mental notes; complete the goal, or setBlockedBy.",
});

const session = agent.createSession("Weather in Oslo — should I pack a coat?");
await session.run();

console.log(session.getState().goal);   // { ..., status: "completed", summary: "..." }
console.log(session.getState().notes);  // the structured reasoning it produced
```

Run the full example:

```bash
ANTHROPIC_API_KEY=sk-... npm run example
```

## Concepts

### Built-in cognition tools

The harness adds three tools to every agent (alongside your effect tools) and
describes the contract in the system prompt:

| Tool | What it does |
| --- | --- |
| `addMentalNote(entry)` | Record one structured reasoning step. Returns its id (so later notes can reference it). Does **not** end the turn — the model's thinking channel. |
| `setGoalCompleted(summary, verification)` | Mark the goal done — only after validating; `verification` records how. Ends the run. |
| `setBlockedBy(reason)` | Declare a blocker only the host can clear. Ends the run; `unblock()` resumes. |

### Driving a session

A `Session` pursues one goal and is also a reactive store. You drive it with two
verbs:

```ts
const session = agent.createSession("Refactor the auth module");

await session.run();                          // pursue the goal until it yields
// …agent yields blocked: state.blockedBy === "Approve editing auth.ts?"
await session.unblock("Approved, go ahead");  // reply + resume
```

Both run the agent until it yields and return a `TurnResult` (`stoppedBy` is
`"completed"`, `"blocked"`, `"final-tool"`, or `"max-turns"`). A new goal is a new
session. `agent.run(goal)` is a one-shot convenience (new session + `run`).

### Sessions are reactive

```ts
session.subscribe((state, toolCalls) => render(state)); // fires on every change
session.getState();      // current cognition state
session.getToolCalls();  // the tool-call log
```

It notifies on every state change *and* every tool call, so a UI re-renders as
the agent thinks and works. `getState` / `subscribe` are stable references, so
they plug straight into React's `useSyncExternalStore`.

### Tools (effects)

A tool is a name, a description, a [Zod](https://zod.dev) input schema, and a
handler. Build them with `defineTool`. The handler gets a `ctx`:

| Field | Purpose |
| --- | --- |
| `ctx.getState()` | Read the current cognition state. |
| `ctx.setState` | Update cognition state (and re-render). |
| `ctx.callId` | The current tool-call id. |
| `ctx.signal` | Aborts with the run's `AbortSignal`. |
| `ctx.stop({ reason, value })` | Hand control back early from your own tool. |

Tool *configuration* (a workspace path, an API key, a DB handle) is **not**
cognition state — it belongs to the tool, injected when you build it (e.g. a
`makeTools(workspace)` factory).

### Skills

Rather than add a tool per capability, capabilities live on disk as **skills** —
small CLIs the agent runs with its shell tool. A skill is a folder with a
`SKILL.md` (frontmatter `name` / `description`, then instructions) plus its
scripts:

```
.state-harness/skills/
  validate-ui/
    SKILL.md        # --- name: validate-ui / description: … --- then how to run it
    run.sh
```

`loadSkillsFromDir(".state-harness/skills")` discovers them; pass the result as
`createAgent({ skills })`. The harness lists each skill's name + description in the
system prompt and adds one built-in tool, **`loadSkill(name)`**, which returns a
skill's full `SKILL.md` body and its files — progressive disclosure, so only the
skill the agent actually needs costs context. The agent then runs the scripts with
your shell tool.

This closes the loop with validation-first: a capability no skill provides is a
**missing skill**. The agent records a `skillGap` mental note (what it must do and
why), then **creates or improves the skill autonomously** — building a skill to
reach the goal is part of the work, not a reason to block. It only `setBlockedBy`s
if it genuinely can't build the capability itself (it needs access or an action
only you can do). On completion it reports `skillSuggestions` — improvements to the
skills it used.

### Docs

Where skills are reusable *capabilities* (you **execute** them), **docs** are
reusable *knowledge* (you **read** them) — the agent's durable, cross-session
memory of a project. They live under `.state-harness/docs/<domain>/<feature>.md`
(markdown with `title` / `description` frontmatter), grouped by domain:

```
.state-harness/docs/
  reactx/
    reactive-state.md     # --- title / description --- then the knowledge
    observer-binding.md
  vite/
    plugin-setup.md
```

`loadDocsFromDir(".state-harness/docs")` discovers them; pass the result as
`createAgent({ docs })`. The harness lists every domain (and each doc's
frontmatter) in the system prompt and adds **`loadDoc(domain, name)`** for
progressive disclosure. The trigger to write one mirrors skills: where a
**`skillGap`** prompts authoring a *skill*, a **`reference`** note (a pointer to
docs the agent found, local or web) prompts distilling the durable knowledge into
a *doc* — what a future run would need, not this run's transient findings. Because
notes don't survive across sessions but docs do, this is how the agent gets better
on a project over time.

### Context compaction

A long run will eventually fill the model's context window. Because all reasoning
is forced into structured **notes**, the harness can compact losslessly-enough: it
**rebuilds the transcript from the notes** (replayed as the agent's own
`addMentalNote` calls, ids and cross-refs intact) plus a compact **action ledger**
— one line per effect call (`wrote src/state.ts`, `npm run build → exit 0`) — and
drops the bulky tool I/O. The files on disk still hold the real output; the agent
re-reads what it needs.

It triggers automatically: **proactively** when the last request's input tokens
cross `compactAtTokens` (default ~800k, ≈80% of Opus 4.8's 1M window), and
**reactively** as a backstop if a generation overflows. The notes and ledger are append-only and
the transcript is rebuilt from them — never appended to — so nothing is duplicated
across repeated compactions. The cognition state (goal, notes, `blockedBy`) lives
outside the transcript, so it's untouched.

```ts
createAgent({ provider, tools, compactAtTokens: 800_000 }); // tune or omit
```

### Lifecycle hooks

Optional `hooks` on `createAgent` — `onTurnStart` / `onToolCall` (gate, return
`{ allow: false }`) / `onToolResult` / `onTurnEnd` / `onError` / `onCompact` (fires
when the transcript is compacted), each carrying `getState` and `setState`.

## Providers

```ts
interface Provider {
  readonly name: string;
  readonly pricing?: ModelPricing;   // $/1M in·out·cache — for cost estimation
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

The API returns token **usage** (counts) but not prices, so the provider also
supplies **`pricing`** (the model's published per-1M rates — `anthropicProvider`
fills it in by `model`, overridable). The harness sums usage across the session
and exposes **`session.estimatedCost()`** (US$, or `undefined` if the provider
declares no pricing); the CLI shows it in the `done` event.

## The CLI: a goal-driven coding agent

`cli/` is a coding agent in a sandboxed workspace, built on the SDK with
[Ink](https://github.com/vadimdemedes/ink) (React for the terminal):

```bash
ANTHROPIC_API_KEY=sk-... npm run cli -- "add a /health endpoint to server.js"
```

It projects the agent's cognition live as it works:

- **Goal** — the one thing the session is pursuing (static at the top).
- **Events** — the structured mental notes stream in as the agent thinks
  (findings, a decision with its rejected alternatives, a plan…), and the final
  `done` event carries the summary, how it was **verified**, a per-type tool-call
  tally, and the session's token usage + estimated cost.
- **Pending bar** — the current tool call (`write_file index.html`) when there is
  one, falling back to `thinking…` while the model is generating, with a live
  tool-call count; it turns back into the input when the agent yields.

Text the agent writes (summaries, notes, verification) is rendered as **markdown**
— inline `code`, **bold**/*italic*, bullet/numbered lists, headings, and
syntax-highlighted code fences (via `cli-highlight`) — by a small Ink renderer
([cli/markdown.tsx](cli/markdown.tsx)).

How it behaves: it does the work — explore, `write_file` / `edit` — then tries to
**validate from the user's perspective** (drive the actual UI, run the command —
not just a clean build) and **`setGoalCompleted`** with a summary and how it
verified. It doesn't ask permission or offer you choices it can make itself; it
decides and notes why. But when it *can't* validate as the user would — e.g. the
deliverable is a web UI and it has no browser tool — it **`setBlockedBy`s and asks
you for a validation tool** (it won't fall back to a unit test or declare success),
then you reply, which **`unblock`s** it.

See [cli/tools.ts](cli/tools.ts) (effect tools), [cli/cli.tsx](cli/cli.tsx)
(SDK wiring + new-goal / unblock routing), [cli/app.tsx](cli/app.tsx) (the Ink
UI), and [cli/markdown.tsx](cli/markdown.tsx) (the markdown renderer).

> **Note:** `bash` is not sandboxed — it runs with the workspace as cwd but a
> command can reach outside it. It's a local dev tool on your own machine.

## API surface

| Export | What it is |
| --- | --- |
| `createAgent` / `Agent` | Define an agent by its effect `tools`. |
| `agent.createSession(goal)` | Start a reactive `Session` for one goal. |
| `session.run` / `session.unblock` | Drive it: pursue the goal, or resume it when blocked. |
| `agent.run(goal)` | One-shot convenience. |
| `defineTool` | Build a typed effect tool from a Zod schema. |
| `createCognition` | The built-in cognition tools + prompt fragment (used internally; exported for custom setups). |
| `loadSkillsFromDir` / `createAgent({ skills })` | Discover `.state-harness/skills` and give the agent `loadSkill` + a skill list. |
| `loadDocsFromDir` / `createAgent({ docs })` | Discover `.state-harness/docs/<domain>` and give the agent `loadDoc` + a docs-by-domain list. |
| `Entry` | The Zod schema for a mental note (the reasoning union). |
| `anthropicProvider` | The Anthropic Messages API adapter (forced tool use). |
| `AgentState`, `Goal`, `StoredEntry`, `Tool`, `ToolContext`, … | Types for state, tools, and adapters. |

## License

MIT
