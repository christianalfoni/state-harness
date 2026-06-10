import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "../src/index.js";
import type { Tool } from "../src/index.js";

const execAsync = promisify(exec);

/** Build the effect tools, configured with the sandbox workspace. */
export function makeTools(workspace: string): Tool[] {
  const resolve = (rel: string): string => {
    const root = path.resolve(workspace);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Path escapes the workspace: ${rel}`);
    }
    return abs;
  };

  const readFile = defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file, given a path relative to the workspace root.",
    input: z.object({ path: z.string().describe("Path relative to the workspace root.") }),
    handler: async ({ path: rel }) => await fs.readFile(resolve(rel), "utf8"),
  });

  const listFiles = defineTool({
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

  const writeFile = defineTool({
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file, given a path relative to the workspace root.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace root."),
      content: z.string().describe("Full file contents."),
    }),
    handler: async ({ path: rel, content }) => {
      const abs = resolve(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return { wrote: rel, bytes: Buffer.byteLength(content) };
    },
  });

  const editFile = defineTool({
    name: "edit",
    description:
      "Edit a file by replacing an exact string (prefer over rewriting). oldString must appear " +
      "EXACTLY once unless replaceAll is set.",
    input: z.object({
      path: z.string().describe("Path relative to the workspace root."),
      oldString: z.string().describe("Exact text to replace, unique within the file."),
      newString: z.string().describe("Replacement text."),
      replaceAll: z.boolean().optional().describe("Replace every occurrence."),
    }),
    handler: async ({ path: rel, oldString, newString, replaceAll }) => {
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

  const bash = defineTool({
    name: "bash",
    description:
      "Run a shell command in the workspace (builds, tests, git, installs). Returns stdout, " +
      "stderr, exit code; a non-zero exit is returned, not thrown. Use write_file/edit to change " +
      "code files, not bash.",
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
