import React, { useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { Change, ChangeStatus, DemoState } from "./tools.js";

const STATUS_GLYPH: Record<ChangeStatus, string> = {
  proposed: "○",
  in_progress: "◐",
  done: "●",
};

export interface AppProps {
  /** The current typed session state — re-rendered on every change. */
  state: DemoState;
  workspace: string;
  /** Runs a user message through the agent. Resolves when the agent yields. */
  onSubmit: (input: string) => Promise<void>;
}

export function App({ state, workspace, onSubmit }: AppProps) {
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

  const approved = new Set(state.approvedFiles);
  const pending = state.changes.filter((c) => c.status !== "done" && !approved.has(c.file)).length;

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          state-harness · coding agent
        </Text>
        <Text dimColor>{workspace}</Text>
      </Box>

      <ChangeList changes={state.changes} approved={approved} />

      {pending > 0 && (
        <Box marginTop={1}>
          <Text color="yellow">
            {"  "}
            {pending} change{pending === 1 ? "" : "s"} await approval — type{" "}
            <Text bold>/approve</Text> to approve, or describe what to change.
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        {state.status === "working" ? (
          <Text>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>{" "}
            <Text dimColor>working…</Text>
          </Text>
        ) : (
          <Box>
            <Text color="cyan">you › </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder="ask the agent, /approve, or /exit"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ChangeList({ changes, approved }: { changes: Change[]; approved: Set<string> }) {
  if (changes.length === 0) {
    return <Text dimColor>{"  no changes proposed yet"}</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold>{"  Changes"}</Text>
      {changes.map((change, i) => {
        const awaiting = change.status !== "done" && !approved.has(change.file);
        const color =
          change.status === "done"
            ? "green"
            : change.status === "in_progress"
              ? "yellow"
              : awaiting
                ? "yellow"
                : "gray";
        return (
          <Box key={i} flexDirection="column">
            <Text>
              {"    "}
              <Text color={color}>{STATUS_GLYPH[change.status]}</Text>{" "}
              <Text dimColor={change.status === "done"}>{change.file}</Text>
              {awaiting && <Text color="yellow"> — needs approval</Text>}
            </Text>
            <Text dimColor>
              {"        "}
              {change.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
