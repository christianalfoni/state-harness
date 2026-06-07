import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "../src/index.js";
import type { Tool, ToolDefinition } from "../src/index.js";

const execAsync = promisify(exec);

/**
 * The agent's state, as a schema. `changes` is the model's to maintain;
 * `approvedFiles` and `status` are read-only — only the host (the CLI) sets them.
 */
export const StateSchema = z.object({
  changes: z
    .array(
      z.object({
        file: z.string(),
        description: z.string(),
        status: z.enum(["proposed", "in_progress", "done"]).default("proposed"),
      }),
    )
    .default([]),
  /** Files the user has approved for editing. Read-only to the model. */
  approvedFiles: z.array(z.string()).default([]).readonly(),
  /** Working/idle, driven by the CLI. Read-only to the model. */
  status: z.enum(["idle", "working"]).default("idle").readonly(),
});

export type DemoState = z.infer<typeof StateSchema>;
export type Change = DemoState["changes"][number];
export type ChangeStatus = Change["status"];

/** Build the effect tools, closed over the sandbox workspace. */
export function makeTools(workspace: string): Tool<DemoState>[] {
  const tool = <S extends z.ZodType>(def: ToolDefinition<S, DemoState>) =>
    defineTool<S, DemoState>(def);

  const resolve = (rel: string): string => {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Path escapes the workspace: ${rel}`);
    }
    return abs;
  };

  const requireApproved = (state: DemoState, file: string): void => {
    const approved = state.approvedFiles.some((f) => path.normalize(f) === path.normalize(file));
    if (!approved) {
      throw new Error(
        `"${file}" is not approved for editing. Propose it in the \`changes\` state and ` +
          `wait for the user to approve before writing.`,
      );
    }
  };

  const readFile = tool({
    name: "read_file",
    description: "Read a UTF-8 text file, given a path relative to the workspace root.",
    input: z.object({ path: z.string().describe("Path relative to the workspace root.") }),
    handler: async ({ path: rel }) => await fs.readFile(resolve(rel), "utf8"),
  });

  const listFiles = tool({
    name: "list_files",
    description:
      "List entries directly under a path in the workspace (directories suffixed with '/'). " +
      "Use this to explore before proposing changes.",
    input: z.object({
      path: z.string().default(".").describe("Directory relative to the workspace root."),
    }),
    handler: async ({ path: rel }) => {
      const entries = await fs.readdir(resolve(rel), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    },
  });

  const writeFile = tool({
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file. The file must be APPROVED first (propose it " +
      "in `changes` and wait for the user) — this fails otherwise.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace root."),
      content: z.string().describe("Full file contents."),
    }),
    handler: async ({ path: rel, content }, ctx) => {
      requireApproved(ctx.getState(), rel);
      const abs = resolve(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return { wrote: rel, bytes: Buffer.byteLength(content) };
    },
  });

  const editFile = tool({
    name: "edit",
    description:
      "Edit a file by replacing an exact string (prefer over rewriting). The file must be " +
      "APPROVED first. oldString must appear EXACTLY once unless replaceAll is set.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace root."),
      oldString: z.string().describe("Exact text to replace, unique within the file."),
      newString: z.string().describe("Replacement text."),
      replaceAll: z.boolean().optional().describe("Replace every occurrence."),
    }),
    handler: async ({ path: rel, oldString, newString, replaceAll }, ctx) => {
      requireApproved(ctx.getState(), rel);
      const abs = resolve(rel);
      const content = await fs.readFile(abs, "utf8");
      const matches = content.split(oldString).length - 1;
      if (matches === 0) throw new Error(`oldString not found in ${rel}.`);
      if (matches > 1 && !replaceAll) {
        throw new Error(`oldString matches ${matches} times in ${rel}; add context or set replaceAll.`);
      }
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await fs.writeFile(abs, updated, "utf8");
      return { edited: rel, replacements: replaceAll ? matches : 1 };
    },
  });

  const bash = tool({
    name: "bash",
    description:
      "Run a shell command in the workspace (builds, tests, git, installs). Returns stdout, " +
      "stderr, exit code; a non-zero exit is returned, not thrown. Do NOT use it to edit " +
      "code files — use write_file/edit so the change goes through approval.",
    input: z.object({ command: z.string().describe("The shell command to run.") }),
    handler: async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspace,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
        return { exitCode: 0, stdout: clip(stdout), stderr: clip(stderr) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
        return {
          exitCode: typeof e.code === "number" ? e.code : 1,
          stdout: clip(e.stdout ?? ""),
          stderr: clip(e.stderr ?? e.message ?? String(err)),
        };
      }
    },
  });

  return [readFile, listFiles, writeFile, editFile, bash];
}

function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars)`;
}
