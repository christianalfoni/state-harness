import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";

/** An id assigned to a stored mental note (`e1`, `e2`, …). Entries reference each other by it. */
export const EntryId = z.string();

/**
 * A single structured thought. The model "thinks out loud" by emitting these
 * instead of free text — every kind is a different shape of reasoning, so the
 * thinking is renderable and inspectable rather than prose to parse.
 */
export const Entry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("finding"),
    body: z.string().describe("Something you observed or learned."),
    evidence: z
      .array(z.string())
      .describe("Tool-call ids or note ids (e.g. 'e3') that back this up."),
  }),
  z.object({
    kind: z.literal("hypothesis"),
    body: z.string().describe("A guess you might act on but haven't confirmed."),
    impact: z
      .enum(["low", "med", "high"])
      .describe("How bad it would be if this guess is wrong — for prioritizing what to check."),
    verifyBy: z
      .string()
      .describe("The concrete check that would confirm or refute it — what to run or observe."),
  }),
  z.object({
    kind: z.literal("decision"),
    body: z.string().describe("A choice you're committing to."),
    basedOn: z.array(EntryId).describe("Note ids this decision rests on."),
    alternatives: z
      .array(z.object({ option: z.string(), rejectedBecause: z.string() }))
      .describe("Options you considered and why you rejected them."),
  }),
  z.object({
    kind: z.literal("constraint"),
    body: z.string().describe("A rule or limit you must respect."),
    source: z.string().describe("Where the constraint comes from (the user, the code, an API…)."),
  }),
  z.object({
    kind: z.literal("plan"),
    steps: z.array(
      z.object({
        body: z.string(),
        status: z.enum(["todo", "doing", "done", "dropped"]),
      }),
    ),
  }),
  z.object({
    kind: z.literal("revision"),
    supersedes: EntryId.describe("The note id this one corrects or replaces."),
    body: z.string().describe("The corrected understanding."),
  }),
  z.object({
    kind: z.literal("skillGap"),
    need: z.string().describe("The skill/capability you're missing — what it must let you do."),
    reason: z.string().describe("Why reaching the goal needs it."),
  }),
  z.object({
    kind: z.literal("reference"),
    topic: z.string().describe("What this documents — the subject (e.g. 'reactx reactive() API')."),
    location: z.string().describe("Where the documentation is: a file path or a URL."),
    scope: z.enum(["local", "web"]),
    summary: z.string().optional().describe("Optional one line on what's there or why it matters."),
  }),
]);
export type Entry = z.infer<typeof Entry>;

/** A note as stored: the entry the model emitted, plus the id the harness assigned it. */
export type StoredEntry = Entry & { id: string };

/** A suggested improvement to a skill the agent used. */
export interface SkillSuggestion {
  skill: string;
  suggestion: string;
}

/** The single unit of work a session pursues — set once, at session creation. */
export interface Goal {
  body: string;
  status: "active" | "completed";
  /** The agent's summary of what it accomplished, set when it completes the goal. */
  summary: string | null;
  /** How the agent validated the goal's behavior, set when it completes the goal. */
  verification: string | null;
  /** Improvements the agent suggests for skills it used. Set on completion; `[]` if none. */
  skillSuggestions: SkillSuggestion[];
}

/**
 * The harness's fixed cognition state — the thing your UI projects and the
 * agent's whole observable surface. There is no user-defined schema: a session
 * pursues one {@link goal}, reasons in {@link notes}, and signals {@link blockedBy}.
 */
export interface AgentState {
  /** The session's goal. The agent can complete it but cannot change or add to it. */
  goal: Goal;
  /** The structured reasoning log, in order. Each carries an `id`. */
  notes: StoredEntry[];
  /** When set, the agent yielded because it needs something from the host (the reason). */
  blockedBy: string | null;
}

/** A fresh cognition state for `goal`. */
export function initialAgentState(goal: string): AgentState {
  return {
    goal: { body: goal, status: "active", summary: null, verification: null, skillSuggestions: [] },
    notes: [],
    blockedBy: null,
  };
}

/** The names of the built-in cognition tools (not "actions" — excluded from the action ledger). */
export const COGNITION_TOOL_NAMES = new Set(["addMentalNote", "setGoalCompleted", "setBlockedBy"]);

export interface Cognition {
  /** The built-in tools: `addMentalNote`, `setGoalCompleted`, `setBlockedBy`. */
  tools: Tool[];
  /** A system-prompt fragment teaching the model the goal/note/block contract. */
  preamble: string;
}

/**
 * Build the harness's built-in cognition tools and the prompt fragment that
 * teaches the model how to use them. These mutate the session's
 * {@link AgentState} through `ctx.setState` and yield through `ctx.stop`.
 */
export function createCognition(): Cognition {
  const addMentalNote = defineTool({
    name: "addMentalNote",
    description:
      "Think — out loud but structured. Record one reasoning step (a finding, hypothesis, " +
      "decision, constraint, plan, or revision). This is your scratchpad: it does NOT end your " +
      "turn, it's not shown to the user as prose, and you should use it freely before and " +
      "between actions. Returns the note's id so later notes can reference it (e.g. a decision's " +
      "`basedOn`, a revision's `supersedes`).",
    input: z.object({ entry: Entry }),
    handler: ({ entry }, ctx) => {
      const state = ctx.getState();
      const id = `e${state.notes.length + 1}`;
      const stored: StoredEntry = { ...entry, id } as StoredEntry;
      ctx.setState({ ...state, notes: [...state.notes, stored] });
      return { id };
    },
  });

  const setGoalCompleted = defineTool({
    name: "setGoalCompleted",
    description:
      "Mark the goal as done. Call this ONLY after you have validated the result FROM THE USER'S " +
      "PERSPECTIVE — exercised it the way its actual user would and observed it work. This ENDS " +
      "the run. Provide a `summary` of what you did and a `verification` stating exactly how you " +
      "confirmed it from the user's side (what you drove and what you observed). If you have no " +
      "tool to validate it from the user's perspective, do NOT complete and do NOT substitute a " +
      "proxy (build/lint/unit test/script) — setBlockedBy instead.",
    input: z.object({
      summary: z.string().describe("A short summary of what you accomplished."),
      verification: z
        .string()
        .describe(
          "How you validated the result FROM THE USER'S PERSPECTIVE: what you actually exercised " +
            "(the UI, the command, the endpoint — as a user would) and what you observed. " +
            "Building, compiling, linting, or testing internal code does NOT count.",
        ),
      skillSuggestions: z
        .array(z.object({ skill: z.string(), suggestion: z.string() }))
        .optional()
        .describe(
          "Improvements for any skills you used — one entry per skill, with a concrete " +
            "suggestion. Omit if you used no skills or have nothing to suggest.",
        ),
    }),
    handler: ({ summary, verification, skillSuggestions }, ctx) => {
      const state = ctx.getState();
      ctx.setState({
        ...state,
        goal: {
          ...state.goal,
          status: "completed",
          summary,
          verification,
          skillSuggestions: skillSuggestions ?? [],
        },
      });
      ctx.stop({ reason: "completed", value: { summary, verification } });
      return { completed: true };
    },
  });

  const setBlockedBy = defineTool({
    name: "setBlockedBy",
    description:
      "Declare that you genuinely CANNOT reach the goal on your own — something outside your " +
      "control stops you: information you have no way to obtain, access/a credential you lack, " +
      "an action only the user can perform, or no way to validate the result that you can't " +
      "build yourself either. This ENDS the run. State exactly what you need. Do NOT use it to " +
      "ask permission to do work you're equipped to do (including creating or changing a skill " +
      "to reach the goal — do that autonomously), to confirm an approach you could just carry " +
      "out, or to offer choices you could make yourself — DECIDE (record it with addMentalNote) " +
      "and proceed. Asking when you could just act is the most common misuse.",
    input: z.object({
      reason: z.string().describe("Exactly what you need from the user that you cannot get or do yourself."),
    }),
    handler: ({ reason }, ctx) => {
      ctx.setState({ ...ctx.getState(), blockedBy: reason });
      ctx.stop({ reason: "blocked", value: reason });
      return { blocked: true };
    },
  });

  const entrySchema = zodToJsonSchema(Entry, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete entrySchema.$schema;

  const preamble =
    "You pursue a single GOAL the user sets. You don't invent or change it; you complete it " +
    "(or tell the user when you're blocked).\n\n" +
    "Three built-in tools shape how you work:\n" +
    "• addMentalNote — your thinking channel. You have no free-text turn, so reason HERE: " +
    "record findings, hypotheses (with how you'd falsify them), decisions (with the notes they " +
    "rest on and the alternatives you rejected), constraints, plans, revisions when you change " +
    "your mind, skill gaps when you're missing a capability (what it must do and why), and " +
    "references when you find documentation worth keeping (where it lives — local or web). It " +
    "never ends your turn — use it liberally before and between actions.\n" +
    "• setGoalCompleted — call it once the goal is truly finished AND validated, with a summary " +
    "and how you verified it. This ends the run.\n" +
    "• setBlockedBy — ONLY when something outside your control stops you from reaching the goal " +
    "(information you can't obtain, access you lack, an action only the user can take, or no way " +
    "to validate the result). Don't ask permission or confirm an approach you could just carry " +
    "out, and don't offer choices you could decide yourself — act, and note the decision. This " +
    "ends the run.\n\n" +
    "VALIDATE FROM THE USER'S PERSPECTIVE. A goal is proven only by exercising the result the way " +
    "its actual user or consumer would — never by a proxy. Building, compiling, linting, " +
    "unit-testing internal functions, or calling your code from a throwaway script do NOT count: " +
    "all of those can pass while the real experience is broken. Early on, work out how the result " +
    "is actually used and whether your tools let you exercise it THAT way and observe the " +
    "outcome. If they don't (e.g. the result is something a user would see and interact with, but " +
    "you have no way to drive it and watch what happens), do not fall back to a weaker proxy and " +
    "do not declare success — get a way to validate it: build or obtain the capability you need " +
    "yourself, and only setBlockedBy if that is genuinely beyond you. You may only " +
    "setGoalCompleted after validating from the user's perspective, and you must report exactly " +
    "how in `verification`.\n\n" +
    "The shape of a mental note (the `entry`):\n" +
    JSON.stringify(entrySchema) +
    "\n\nThe run is: figure out how you'll validate the goal, think and act freely (addMentalNote " +
    "+ your effect tools), validate, then setGoalCompleted — or, if you can't proceed or can't " +
    "validate, setBlockedBy. If you're blocked the user may reply to unblock you, and you continue.";

  return { tools: [addMentalNote, setGoalCompleted, setBlockedBy], preamble };
}
