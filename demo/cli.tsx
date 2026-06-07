import fs from "node:fs/promises";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { createAgent, anthropicProvider } from "../src/index.js";
import { StateSchema, makeTools, type DemoState } from "./tools.js";
import { App } from "./app.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in your environment.");
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("The demo is a TUI and needs an interactive terminal (a TTY).");
  process.exit(1);
}

const workspace = path.resolve(process.cwd(), "demo/workspace");
await fs.mkdir(workspace, { recursive: true });

const agent = createAgent({
  provider: anthropicProvider({ model: "claude-opus-4-8" }),
  state: StateSchema,
  tools: makeTools(workspace),
  system:
    "You are a coding agent in a sandboxed workspace, in an ongoing chat with the user.\n\n" +
    "IMPORTANT: setState ENDS your turn (it commits state AND hands control to the user). So " +
    "do all your reads/edits first, then setState ONCE to hand back. bash / list_files / " +
    "read_file / write_file / edit do NOT end your turn.\n\n" +
    "To change code you MUST get approval first. The flow:\n" +
    "1. Explore with bash / list_files / read_file.\n" +
    "2. When ready, setState `changes` to the full list of files you'll touch (each entry " +
    "{ file, description, status: 'proposed' }). This hands control to the user to approve.\n" +
    "3. The user approves by adding files to `approvedFiles` (read-only to you). On your next " +
    "turn, getState to see `approvedFiles`, make every approved edit with write_file / edit " +
    "(they FAIL on unapproved files), then setState `changes` with those entries' status " +
    "'done' — which hands back.\n" +
    "4. Use bash for builds/tests, never to edit code files.",
  maxTurns: 60,
});

async function runAgent(message: string): Promise<void> {
  session.setState((s) => ({ ...s, status: "working" }));
  try {
    await session.send(message);
  } catch {
    // A fatal provider error; the session returns to idle below.
  } finally {
    session.setState((s) => ({ ...s, status: "idle" }));
  }
}

async function submit(input: string): Promise<void> {
  const trimmed = input.trim();
  const state = session.getState();
  const pendingFiles = state.changes
    .filter((c) => c.status !== "done" && !state.approvedFiles.includes(c.file))
    .map((c) => c.file);

  // `/approve` is a USER action — it writes the read-only `approvedFiles` field
  // directly (the model's setState can't), then wakes the agent to implement.
  if (pendingFiles.length > 0 && (trimmed === "/approve" || trimmed === "/approve all")) {
    session.setState((s) => ({
      ...s,
      approvedFiles: [...new Set([...s.approvedFiles, ...pendingFiles])],
    }));
    await runAgent(`I approve these files: ${pendingFiles.join(", ")}. Go ahead and implement them.`);
    return;
  }

  await runAgent(input);
}

// Render the Ink tree from the typed state, re-rendering on every change.
const view = (state: DemoState) => (
  <App state={state} workspace={workspace} onSubmit={submit} />
);

const session = agent.createSession();
const app = render(view(session.getState()));
session.subscribe((state) => app.rerender(view(state)));

const initial = process.argv.slice(2).join(" ").trim();
if (initial) void submit(initial);

await app.waitUntilExit();
