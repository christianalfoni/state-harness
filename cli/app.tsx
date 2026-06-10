import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { AgentState, Goal, StoredEntry, ToolCall, Usage } from "../src/index.js";
import { Markdown, inlineMarkdown } from "./markdown.js";

/** The cognition tools — shown as "thinking" (not work), and left out of the tally. */
export const COGNITION_TOOLS = new Set(["addMentalNote", "setGoalCompleted", "setBlockedBy"]);

const NOTE_GLYPH: Record<StoredEntry["kind"], string> = {
  finding: "🔍",
  hypothesis: "❓",
  decision: "✓",
  constraint: "⛓",
  plan: "▤",
  revision: "↻",
  skillGap: "🧩",
  reference: "📚",
};

const STEP_GLYPH: Record<"todo" | "doing" | "done" | "dropped", string> = {
  todo: "○",
  doing: "◐",
  done: "●",
  dropped: "⊘",
};

// Indentation is done with Box padding (NOT leading spaces) so wrapped lines stay
// aligned. INDENT = the view's left margin; DETAIL = extra indent for the blocked
// banner; ICON_W = the fixed-width gutter that aligns event text into a timeline.
const INDENT = 2;
const DETAIL = 3;
const ICON_W = 3;

// Impact severity: low is fine (green), high is dangerous-if-wrong (red).
const IMPACT_COLOR: Record<"low" | "med" | "high", string> = {
  low: "green",
  med: "yellow",
  high: "red",
};

/** How many of the most recent events to keep on screen (older ones collapse). */
const MAX_EVENTS = 8;

export interface AppProps {
  /** The current session's cognition state, or null before any goal is set. */
  state: AgentState | null;
  /** The cumulative tool-call log for the session. */
  toolCalls: ToolCall[];
  /** Cumulative token usage for the session. */
  usage: Usage;
  /** Estimated cumulative cost (US$), or undefined if the provider has no pricing. */
  costUsd: number | undefined;
  /** True while the agent is running. */
  working: boolean;
  /** True while the model is generating (between tool batches) — show "thinking". */
  generating: boolean;
  /** How many times the transcript has been compacted to fit the context window. */
  compactions: number;
  workspace: string;
  /** Starts a new goal, or replies to unblock the current session. */
  onSubmit: (input: string) => Promise<void>;
}

export function App({
  state,
  toolCalls,
  usage,
  costUsd,
  working,
  generating,
  compactions,
  workspace,
  onSubmit,
}: AppProps) {
  const [input, setInput] = useState("");
  const { exit } = useApp();

  const submit = (value: string): void => {
    const text = value.trim();
    setInput("");
    if (!text) return;
    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }
    void onSubmit(text);
  };

  return (
    <Box flexDirection="column" paddingY={1} paddingLeft={INDENT}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          coding agent
        </Text>
        <Text dimColor>{workspace}</Text>
        {compactions > 0 && (
          <Text dimColor>
            ⟳ context compacted ×{compactions} (kept the notes + action log)
          </Text>
        )}
      </Box>

      {state ? (
        <>
          <GoalView goal={state.goal} />
          <EventStream
            notes={state.notes}
            goal={state.goal}
            toolCalls={toolCalls}
            usage={usage}
            costUsd={costUsd}
          />

          {state.blockedBy && !working && (
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow">⏸ blocked — the agent needs you:</Text>
              <Box paddingLeft={DETAIL}>
                <Markdown text={state.blockedBy} />
              </Box>
            </Box>
          )}
        </>
      ) : (
        <Box flexDirection="column">
          <Text color="cyan" bold>
            Welcome — what should the agent do?
          </Text>
          <Text dimColor>Type a goal below and press enter.</Text>
        </Box>
      )}

      {/* The command bar: an editable input when idle, the pending indicator when working. */}
      <Box
        marginTop={1}
        width="100%"
        borderStyle="round"
        borderColor={working ? "yellow" : state?.blockedBy ? "yellow" : "cyan"}
        paddingX={1}
      >
        {working ? (
          <PendingLine toolCalls={toolCalls} generating={generating} />
        ) : (
          <Box>
            <Text color="cyan" bold>
              {state?.blockedBy ? "reply › " : "goal › "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder={state?.blockedBy ? "what the agent needs…" : "describe the goal…"}
            />
          </Box>
        )}
      </Box>
      <Text dimColor>/exit to quit</Text>
    </Box>
  );
}

function GoalView({ goal }: { goal: Goal }) {
  // Static — the goal text never changes; completion shows as an event, not here.
  return (
    <Text>
      <Text bold>Goal  </Text>
      {inlineMarkdown(goal.body)}
    </Text>
  );
}

/** The agent's reasoning as a stream of spaced events (most recent at the bottom). */
function EventStream({
  notes,
  goal,
  toolCalls,
  usage,
  costUsd,
}: {
  notes: StoredEntry[];
  goal: Goal;
  toolCalls: ToolCall[];
  usage: Usage;
  costUsd: number | undefined;
}) {
  const report = goal.status === "completed" && goal.summary ? goal.summary : null;
  if (notes.length === 0 && !report) return null;
  const hidden = Math.max(0, notes.length - MAX_EVENTS);
  const shown = notes.slice(-MAX_EVENTS);
  return (
    <Box flexDirection="column" marginTop={1}>
      {hidden > 0 && (
        <Text dimColor>
          ┄ {hidden} earlier event{hidden === 1 ? "" : "s"}
        </Text>
      )}
      {shown.map((note) => (
        <Event key={note.id} note={note} />
      ))}
      {report && (
        <DoneEvent
          goal={goal}
          report={report}
          toolCalls={toolCalls}
          usage={usage}
          costUsd={costUsd}
        />
      )}
    </Box>
  );
}

/** One timeline row: a fixed-width icon gutter so all event text aligns in a column. */
function Row({ glyph, children }: { glyph: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box width={ICON_W} flexShrink={0}>
        <Text>{glyph}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

function Event({ note }: { note: StoredEntry }) {
  const inline =
    note.kind === "finding" ||
    note.kind === "hypothesis" ||
    note.kind === "constraint" ||
    note.kind === "revision";

  return (
    <Row glyph={NOTE_GLYPH[note.kind]}>
      <Text>
        <Text color="magenta" bold>
          {note.kind}
        </Text>
        {inline && <Text>  {inlineMarkdown(note.body)}</Text>}
      </Text>

      {note.kind === "decision" && (
        <>
          <Text>✔ {inlineMarkdown(note.body)}</Text>
          <Box flexDirection="column" marginTop={1}>
            {note.alternatives.map((alt, i) => (
              <Text key={i} dimColor>
                ✗ {inlineMarkdown(alt.option)} — {inlineMarkdown(alt.rejectedBecause)}
              </Text>
            ))}
          </Box>
        </>
      )}

      {note.kind === "hypothesis" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={IMPACT_COLOR[note.impact]} bold>
              Impact{"  "}
            </Text>
            {note.impact}
          </Text>
          <Text>
            <Text color="cyan" bold>
              Verify{"  "}
            </Text>
            {inlineMarkdown(note.verifyBy)}
          </Text>
        </Box>
      )}

      {note.kind === "constraint" && (
        <Box marginTop={1}>
          <Text dimColor>source: {inlineMarkdown(note.source)}</Text>
        </Box>
      )}

      {note.kind === "plan" && (
        <Box flexDirection="column" marginTop={1}>
          {note.steps.map((step, i) => (
            <Text key={i} dimColor>
              {STEP_GLYPH[step.status]} {inlineMarkdown(step.body)}
            </Text>
          ))}
        </Box>
      )}

      {note.kind === "skillGap" && (
        <Box flexDirection="column">
          <Text>{inlineMarkdown(note.need)}</Text>
          <Text dimColor>why: {inlineMarkdown(note.reason)}</Text>
        </Box>
      )}

      {note.kind === "reference" && (
        <Box flexDirection="column">
          <Text>{inlineMarkdown(note.topic)}</Text>
          <Text dimColor>
            {note.scope} · {note.location}
          </Text>
          {note.summary && <Text dimColor>{inlineMarkdown(note.summary)}</Text>}
        </Box>
      )}
    </Row>
  );
}

function DoneEvent({
  goal,
  report,
  toolCalls,
  usage,
  costUsd,
}: {
  goal: Goal;
  report: string;
  toolCalls: ToolCall[];
  usage: Usage;
  costUsd: number | undefined;
}) {
  return (
    <Row glyph="🏁">
      <Text color="green" bold>
        done
      </Text>
      <Markdown text={report} />
      {goal.verification && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green" bold>
            verified
          </Text>
          <Markdown text={goal.verification} />
        </Box>
      )}
      {goal.skillSuggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            skill notes
          </Text>
          {goal.skillSuggestions.map((s, i) => (
            <Text key={i} dimColor>
              {s.skill} — {inlineMarkdown(s.suggestion)}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <ToolTally toolCalls={toolCalls} />
        <UsageLine usage={usage} costUsd={costUsd} />
      </Box>
    </Row>
  );
}

/** The end-of-run usage line: token totals + an estimated cost (when the provider prices it). */
function UsageLine({ usage, costUsd }: { usage: Usage; costUsd: number | undefined }) {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const total = input + output + cached;
  const parts = [`${fmtTokens(input)} in`, `${fmtTokens(output)} out`];
  if (cached > 0) parts.push(`${fmtTokens(cached)} cache`);
  return (
    <Text dimColor>
      {fmtTokens(total)} tokens ({parts.join(" · ")})
      {costUsd !== undefined && ` · ≈ ${fmtCost(costUsd)}`}
    </Text>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** The bottom indicator while working: the running tool (or "thinking") + tool-call count. */
function PendingLine({ toolCalls, generating }: { toolCalls: ToolCall[]; generating: boolean }) {
  const last = toolCalls[toolCalls.length - 1];
  const showTool = !generating && last && !COGNITION_TOOLS.has(last.name);

  return (
    <Text>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>{" "}
      {showTool ? (
        <Text>
          <Text color="cyan">{last.name}</Text>
          <Text dimColor> {summarizeInput(last.input)}</Text>
        </Text>
      ) : (
        <Text dimColor>thinking…</Text>
      )}
      <Text dimColor>
        {"   ·   "}
        {toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}
      </Text>
    </Text>
  );
}

/** "12 tool calls (5× bash · 3× write_file · …)" — total plus a per-type breakdown. */
function ToolTally({ toolCalls }: { toolCalls: ToolCall[] }) {
  const calls = toolCalls.filter((call) => !COGNITION_TOOLS.has(call.name));
  const total = calls.length;
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n}× ${name}`)
    .join(" · ");

  return (
    <Text dimColor>
      {total} tool call{total === 1 ? "" : "s"}
      {breakdown && ` (${breakdown})`}
    </Text>
  );
}

/** A short label for a tool call's input (the path it touches, the command it runs, …). */
function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "command", "file"]) {
    if (typeof obj[key] === "string") return clip(obj[key] as string);
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string") return clip(value);
  }
  return "";
}

function clip(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
