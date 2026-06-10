import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";

/** The default directory skills are discovered in (relative to the host's cwd/workspace). */
export const DEFAULT_SKILLS_DIR = ".state-harness/skills";

/** A discovered skill: its meta (from SKILL.md frontmatter) and where it lives. */
export interface SkillMeta {
  /** Skill name, from frontmatter `name:` (falls back to the folder name). */
  name: string;
  /** One-line description, from frontmatter `description:`. Shown in the system prompt. */
  description: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /** Absolute path to the skill's directory (where its scripts live). */
  dir: string;
}

export interface SkillTools {
  /** The built-in `loadSkill` tool. */
  tools: Tool[];
  /** A system-prompt fragment: the skill list + how the skill protocol works. */
  preamble: string;
}

/**
 * Scan a skills directory for `<name>/SKILL.md` files and return their meta.
 * Synchronous (run once at agent setup). Missing/unreadable dir → `[]`.
 */
export function loadSkillsFromDir(dir: string): SkillMeta[] {
  const root = path.resolve(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(root, entry.name);
    const mdPath = path.join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(mdPath, "utf8");
    } catch {
      continue; // a folder without a SKILL.md isn't a skill
    }
    const meta = parseFrontmatter(content);
    skills.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      path: mdPath,
      dir: skillDir,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse the `--- name: … / description: … ---` frontmatter block at the top of a SKILL.md. */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv && kv[1]) out[kv[1]] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { name: out.name, description: out.description };
}

/**
 * Build the `loadSkill` tool and the system-prompt fragment for a set of skills.
 * The harness adds NO per-capability tool: a skill is a small CLI the agent runs
 * with its shell tool, after reading its instructions via `loadSkill`.
 */
export function createSkillTools(skills: SkillMeta[]): SkillTools {
  const byName = new Map(skills.map((s) => [s.name, s]));

  const loadSkill = defineTool({
    name: "loadSkill",
    description:
      "Load a skill's full instructions before you use it. Pass the skill `name` as listed in " +
      "your skills. Returns the SKILL.md body (how to run the skill's scripts) and the files in " +
      "its folder. Skills are small CLIs — run their scripts with your shell tool per the " +
      "instructions; there is no dedicated tool per skill.",
    input: z.object({
      name: z.string().describe("The skill name, exactly as listed in your available skills."),
    }),
    handler: ({ name }) => {
      const skill = byName.get(name);
      if (!skill) {
        const available = [...byName.keys()].join(", ") || "none";
        throw new Error(`Unknown skill: "${name}". Available: ${available}.`);
      }
      const instructions = fs.readFileSync(skill.path, "utf8");
      let files: string[] = [];
      try {
        files = fs.readdirSync(skill.dir);
      } catch {
        /* ignore */
      }
      return { name: skill.name, dir: skill.dir, files, instructions };
    },
  });

  const list = skills.length
    ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    : "(none yet)";

  const preamble =
    "SKILLS — your reusable capabilities. You don't get a tool per capability; each capability " +
    "is a SKILL: a small CLI (one or more scripts) on disk with a SKILL.md describing it. Run a " +
    "skill's scripts with your shell tool, following its instructions.\n" +
    "Available skills:\n" +
    list +
    "\n\nBefore using a skill, call loadSkill(name) to read its full instructions (it returns the " +
    "SKILL.md body and the files in the skill's folder); then run its scripts. If a capability " +
    "you need is NOT covered by an available skill — especially a way to VALIDATE the result " +
    "from the user's perspective — record a `skillGap` mental note (what it must do and why), " +
    "then CREATE that skill (write its SKILL.md + scripts) or IMPROVE an existing one, " +
    "AUTONOMOUSLY. Building or changing a skill to reach the goal is part of the work — it is NOT " +
    "a reason to block; only setBlockedBy if you genuinely can't build the capability yourself " +
    "(e.g. it needs access or an action only the user can do). Never fake a missing capability " +
    "with a weaker proxy. When you finish, if a skill you used was awkward, incomplete, or buggy, " +
    "pass concrete improvements in setGoalCompleted's `skillSuggestions`.";

  return { tools: [loadSkill], preamble };
}
