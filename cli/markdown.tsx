import React from "react";
import { Box, Text } from "ink";
import { highlight } from "cli-highlight";

/**
 * A small, Ink-native markdown renderer for the TUI. Covers what the agent emits
 * — inline `code`, **bold**, *italic*, bullet/numbered lists, headings, and fenced
 * code blocks (syntax-highlighted via cli-highlight) — by rendering Box/Text
 * components, so it wraps and indents with the surrounding layout.
 *
 * Underscore emphasis is intentionally unsupported, so identifiers like
 * `write_file` are safe.
 */

export type InlineKind = "text" | "code" | "bold" | "italic";
export interface InlineToken {
  text: string;
  kind: InlineKind;
}

// Inline spans, in priority order: `code`, then **bold**, then *italic*.
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\s][^*]*?\*)/g;

/** Split a line into styled inline tokens. Pure — unit-testable without rendering. */
export function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(input))) {
    if (m.index > last) tokens.push({ text: input.slice(last, m.index), kind: "text" });
    if (m[1]) tokens.push({ text: m[1].slice(1, -1), kind: "code" });
    else if (m[2]) tokens.push({ text: m[2].slice(2, -2), kind: "bold" });
    else if (m[3]) tokens.push({ text: m[3].slice(1, -1), kind: "italic" });
    last = m.index + m[0].length;
  }
  if (last < input.length) tokens.push({ text: input.slice(last), kind: "text" });
  return tokens;
}

/** Render inline markdown as Text segments — usable inside any `<Text>`. */
export function inlineMarkdown(input: string): React.ReactNode {
  const tokens = tokenizeInline(input);
  if (tokens.length === 1 && tokens[0]!.kind === "text") return input;
  return tokens.map((t, i) => {
    if (t.kind === "code")
      return (
        <Text key={i} color="cyan">
          {t.text}
        </Text>
      );
    if (t.kind === "bold")
      return (
        <Text key={i} bold>
          {t.text}
        </Text>
      );
    if (t.kind === "italic")
      return (
        <Text key={i} italic>
          {t.text}
        </Text>
      );
    return <Text key={i}>{t.text}</Text>;
  });
}

/** A bullet/numbered item whose wrapped lines stay aligned under the text (not the marker). */
function Item({ marker, text }: { marker: string; text: string }) {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text>{marker} </Text>
      </Box>
      <Box flexGrow={1}>
        <Text>{inlineMarkdown(text)}</Text>
      </Box>
    </Box>
  );
}

/** A fenced code block — syntax-highlighted with cli-highlight (plain on failure / no color off-TTY). */
function CodeBlock({ lines, lang }: { lines: string[]; lang?: string }) {
  const code = lines.join("\n");
  let rendered = code;
  try {
    rendered = highlight(code, lang ? { language: lang, ignoreIllegals: true } : { ignoreIllegals: true });
  } catch {
    rendered = code; // unknown language or highlight error → show it plain
  }
  // One <Text> for the whole block so ANSI spans aren't broken across line splits.
  return <Text>{rendered}</Text>;
}

/** Block-level markdown: lines/blocks rendered as a column. Use for multi-line text. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let fence: { lang?: string; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^\s*```(\w+)?/);
    if (fenceMatch) {
      if (fence) {
        blocks.push(<CodeBlock key={i} lines={fence.lines} lang={fence.lang} />);
        fence = null;
      } else {
        fence = { lang: fenceMatch[1], lines: [] };
      }
      continue;
    }
    if (fence) {
      fence.lines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <Text key={i} bold color="cyan">
          {inlineMarkdown(heading[2]!)}
        </Text>,
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(<Item key={i} marker="•" text={bullet[1]!} />);
      continue;
    }
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(<Item key={i} marker={`${numbered[1]}.`} text={numbered[2]!} />);
      continue;
    }
    if (line.trim() === "") {
      blocks.push(<Text key={i}> </Text>);
      continue;
    }
    blocks.push(<Text key={i}>{inlineMarkdown(line)}</Text>);
  }

  if (fence) blocks.push(<CodeBlock key="fence-end" lines={fence.lines} lang={fence.lang} />);

  return <Box flexDirection="column">{blocks}</Box>;
}
