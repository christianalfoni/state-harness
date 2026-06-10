import fs from "node:fs/promises";
import path from "node:path";
import React from "react";
import { render } from "ink";
import {
  createAgent,
  anthropicProvider,
  loadSkillsFromDir,
  loadDocsFromDir,
  DEFAULT_SKILLS_DIR,
  DEFAULT_DOCS_DIR,
  type Agent,
  type Session,
  type TurnResult,
} from "../src/index.js";
import { makeTools } from "./tools.js";
import { App } from "./app.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in your environment.");
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("This is a TUI and needs an interactive terminal (a TTY).");
  process.exit(1);
}

const workspace = path.resolve(process.cwd(), "cli/workspace");
const skillsDir = path.join(workspace, DEFAULT_SKILLS_DIR);
const docsDir = path.join(workspace, DEFAULT_DOCS_DIR);
await fs.mkdir(skillsDir, { recursive: true });
await fs.mkdir(docsDir, { recursive: true });

// Module-level UI state the view is rendered from. The session owns cognition
// state; working / generating are presentation concerns the CLI owns.
let session: Session | null = null;
let unsub: (() => void) | null = null;
let working = false;
let generating = false;
let compactions = 0;

// Built fresh per goal so skills authored during a previous goal are discovered.
function makeAgent(): Agent {
  return createAgent({
    provider: anthropicProvider({ model: "claude-opus-4-8" }),
    tools: makeTools(workspace),
    skills: loadSkillsFromDir(skillsDir),
    docs: loadDocsFromDir(docsDir),
    system:
      `You are a coding agent pursuing the goal the user set. You work in a sandboxed workspace ` +
      `rooted at:\n  ${workspace}\n` +
      "All file tools (read_file / list_files / write_file / edit) take paths RELATIVE to that " +
      "root, and bash runs with it as the working directory. Stay inside it.\n\n" +
      "Think with addMentalNote as you go — record findings as you explore, a decision (with the " +
      "alternatives you rejected) before you commit to an approach, and a plan for multi-step " +
      "work. This is your only reasoning channel.\n\n" +
      "Then just DO the work: explore with bash / list_files / read_file, make the changes with " +
      "write_file / edit. Don't ask for permission and don't offer the user a choice you can make " +
      "yourself — pick the best option, note why, and proceed.\n\n" +
      "VALIDATE FROM THE USER'S PERSPECTIVE before completing. The user experiences this through " +
      "an interface — a web UI in a browser, a CLI's output, an HTTP endpoint's response. Prove " +
      "it works by exercising THAT, the way the user would. A clean build / tsc / lint, or a unit " +
      "test or node script that calls your code directly, is NOT user-perspective validation — it " +
      "can pass while the real interface is broken. If a skill lets you BE the user, use it and " +
      "report it in `verification`. If none does — e.g. it's a web UI you'd need to load and " +
      "click and no skill can drive it — that's a missing skill: note it and BUILD the skill to " +
      "do it (see below), then validate with it. Don't fake it with a unit test.\n\n" +
      "SKILLS live under `.state-harness/skills/<name>/` (relative to the workspace): a SKILL.md " +
      "(with `name`/`description` frontmatter) plus scripts you run with bash. When you need a " +
      "capability no existing skill provides, record a `skillGap` note (what it must do and why), " +
      "then CREATE that skill (write its SKILL.md + scripts) or IMPROVE an existing one — do this " +
      "AUTONOMOUSLY; it's part of the work, not a reason to block. Only setBlockedBy if you " +
      "genuinely can't build the capability yourself (it needs access or an action only the user " +
      "can do). When you finish, suggest improvements for skills you used via setGoalCompleted's " +
      "`skillSuggestions`.\n\n" +
      "DOCS are your durable, cross-session knowledge — markdown under " +
      "`.state-harness/docs/<domain>/<feature>.md` (relative to the workspace), with " +
      "`title`/`description` frontmatter. When you find documentation worth keeping (a library's " +
      "README, an API reference, a local design doc), record a `reference` mental note for WHERE " +
      "it lives, and distill the durable, reusable knowledge into a doc with write_file — what a " +
      "future run on this project would need, not this run's transient findings. Read existing " +
      "docs with loadDoc before relying on them, and update rather than duplicate.\n\n" +
      "Use bash for builds, not to edit code files.",
    hooks: {
      // The model is generating until its tool calls land (cleared in the subscription).
      onTurnStart() {
        generating = true;
        rerender();
      },
      onCompact() {
        compactions++;
        rerender();
      },
    },
  });
}

const app = render(<App {...viewProps()} />);

function viewProps() {
  return {
    state: session?.getState() ?? null,
    toolCalls: session?.getToolCalls() ?? [],
    usage: session?.usage ?? {},
    costUsd: session?.estimatedCost(),
    working,
    generating,
    compactions,
    workspace,
    onSubmit: submit,
  };
}

function rerender(): void {
  app.rerender(<App {...viewProps()} />);
}

async function drive(action: () => Promise<TurnResult>): Promise<void> {
  working = true;
  generating = true;
  rerender();
  try {
    await action();
  } catch {
    // A fatal provider/abort error just returns us to the input.
  } finally {
    working = false;
    generating = false;
    rerender();
  }
}

async function submit(input: string): Promise<void> {
  const trimmed = input.trim();
  const blocked = session?.getState().blockedBy != null;

  // While blocked, your reply gives the agent what it needed and resumes it.
  if (session && blocked) {
    await drive(() => session!.unblock(trimmed));
    return;
  }

  // Otherwise it's a new goal: a brand-new session on a freshly-built agent (so
  // skills authored during the last goal are picked up).
  unsub?.();
  const next = makeAgent().createSession(trimmed);
  session = next;
  unsub = next.subscribe(() => {
    // Any tool call or state change means the model is no longer just generating.
    generating = false;
    rerender();
  });
  await drive(() => next.run());
}

const initial = process.argv.slice(2).join(" ").trim();
if (initial) void submit(initial);

await app.waitUntilExit();
