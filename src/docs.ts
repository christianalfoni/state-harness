import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";

/** The default directory docs are discovered in, organized as `<domain>/<feature>.md`. */
export const DEFAULT_DOCS_DIR = ".state-harness/docs";

/** A discovered doc: its meta (from frontmatter), its domain, and where it lives. */
export interface DocMeta {
  /** The domain (sub-folder) it belongs to. */
  domain: string;
  /** The doc's name (its file's base name, without `.md`). */
  name: string;
  /** Frontmatter `title:` (falls back to the file name). */
  title: string;
  /** Frontmatter `description:` — shown in the system prompt listing. */
  description: string;
  /** Absolute path to the markdown file. */
  path: string;
}

export interface DocTools {
  /** The built-in `loadDoc` tool. */
  tools: Tool[];
  /** A system-prompt fragment: the docs listed by domain + how the docs protocol works. */
  preamble: string;
}

/**
 * Scan a docs directory of `<domain>/<feature>.md` files and return their meta.
 * Synchronous (run once at agent setup). Missing/unreadable dir → `[]`.
 */
export function loadDocsFromDir(dir: string): DocMeta[] {
  const root = path.resolve(dir);
  let domains: fs.Dirent[];
  try {
    domains = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const docs: DocMeta[] = [];
  for (const domain of domains) {
    if (!domain.isDirectory()) continue;
    const domainDir = path.join(root, domain.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(domainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const filePath = path.join(domainDir, file.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const meta = parseFrontmatter(content);
      const name = file.name.replace(/\.md$/, "");
      docs.push({
        domain: domain.name,
        name,
        title: meta.title ?? name,
        description: meta.description ?? "",
        path: filePath,
      });
    }
  }
  return docs.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** Parse the `--- title: … / description: … ---` frontmatter block at the top of a doc. */
function parseFrontmatter(content: string): { title?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv && kv[1]) out[kv[1]] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { title: out.title, description: out.description };
}

/**
 * Build the `loadDoc` tool and the system-prompt fragment for a set of docs.
 * Docs are the agent's durable, cross-session knowledge base — read with
 * `loadDoc`, and written autonomously when the agent finds knowledge worth keeping.
 */
export function createDocTools(docs: DocMeta[]): DocTools {
  const key = (domain: string, name: string) => `${domain}/${name}`;
  const byKey = new Map(docs.map((d) => [key(d.domain, d.name), d]));

  const loadDoc = defineTool({
    name: "loadDoc",
    description:
      "Read one of your documentation notes in full before relying on it. Pass the `domain` " +
      "and `name` exactly as listed in your docs. Returns the doc's content. Docs are your " +
      "durable, cross-session knowledge base — knowledge, not capabilities (those are skills).",
    input: z.object({
      domain: z.string().describe("The doc's domain (folder), as listed."),
      name: z.string().describe("The doc's name within that domain, as listed."),
    }),
    handler: ({ domain, name }) => {
      const doc = byKey.get(key(domain, name));
      if (!doc) {
        const available = [...byKey.keys()].join(", ") || "none";
        throw new Error(`Unknown doc: "${domain}/${name}". Available: ${available}.`);
      }
      const content = fs.readFileSync(doc.path, "utf8");
      return { domain: doc.domain, name: doc.name, title: doc.title, content };
    },
  });

  const byDomain = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    const items = byDomain.get(doc.domain) ?? [];
    items.push(doc);
    byDomain.set(doc.domain, items);
  }
  const list = docs.length
    ? [...byDomain.entries()]
        .map(
          ([domain, items]) =>
            `- ${domain}/\n` +
            items.map((i) => `    - ${i.name}: ${i.description || i.title}`).join("\n"),
        )
        .join("\n")
    : "(none yet)";

  const preamble =
    "DOCS — your durable, cross-session KNOWLEDGE base (knowledge, not capabilities; capabilities " +
    "are skills). Unlike mental notes, which last only this run, docs persist on disk as " +
    "`" +
    DEFAULT_DOCS_DIR +
    "/<domain>/<feature>.md` — a markdown file with `title`/`description` frontmatter, grouped by " +
    "DOMAIN. They are how you get better over time on a project.\n" +
    "Available docs, by domain:\n" +
    list +
    "\n\nCall loadDoc(domain, name) to read one in full before relying on it. And WRITE docs " +
    "AUTONOMOUSLY: when you find documentation worth keeping (record a `reference` mental note " +
    "for WHERE it lives), distill the durable, reusable knowledge into a doc at " +
    "`" +
    DEFAULT_DOCS_DIR +
    "/<domain>/<feature>.md` — what a FUTURE run would need to know, not this run's transient " +
    "findings. Update an existing doc instead of duplicating it. Writing docs is part of the " +
    "work, not a reason to block.";

  return { tools: [loadDoc], preamble };
}
