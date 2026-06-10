import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILLS_ROOT = join(homedir(), ".claude", "skills");

export interface SkillFrontmatter {
  name: string;
  description: string;
  trigger?: string;
  author: string;
  contributors: string[];
  source_sessions: string[];
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExistingSkill {
  name: string;
  path: string;
  frontmatter: SkillFrontmatter | null;
  body: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid skill name "${name}": must be 1-63 chars, lowercase letters, digits, hyphens, starting with letter or digit`,
    );
  }
}

function skillPath(root: string, name: string): string {
  return join(root, name, "SKILL.md");
}

function serializeFrontmatter(fm: SkillFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${quoteIfNeeded(fm.description)}`);
  if (fm.trigger) lines.push(`trigger: ${quoteIfNeeded(fm.trigger)}`);
  lines.push(`author: ${fm.author}`);
  lines.push(`contributors:${fm.contributors.length === 0 ? " []" : "\n" + fm.contributors.map((c) => `  - ${c}`).join("\n")}`);
  lines.push(`source_sessions:`);
  for (const s of fm.source_sessions) lines.push(`  - ${s}`);
  lines.push(`version: ${fm.version}`);
  lines.push(`created_by: ${fm.created_by}`);
  lines.push(`created_at: ${fm.created_at}`);
  lines.push(`updated_at: ${fm.updated_at}`);
  lines.push("---");
  return lines.join("\n");
}

// the frontmatter parser is line-based and Claude Code's YAML loader
// chokes on raw newlines, so flatten these at the write boundary
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function quoteIfNeeded(s: string): string {
  if (s.includes("\n") || s.includes(":") || s.includes("#") || s.startsWith(" ") || s.endsWith(" ")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function parseFrontmatter(raw: string): { fm: SkillFrontmatter | null; body: string } {
  if (!raw.startsWith("---\n")) return { fm: null, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { fm: null, body: raw };
  const fmBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const fm: Partial<SkillFrontmatter> & { contributors?: string[]; source_sessions?: string[] } = {
    contributors: [],
    source_sessions: [],
  };
  const lines = fmBlock.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const [, key, rawVal] = m;
    const value = stripQuotes(rawVal ?? "");
    switch (key) {
      case "name":
        fm.name = value;
        break;
      case "description":
        fm.description = value;
        break;
      case "trigger":
        fm.trigger = value || undefined;
        break;
      case "author":
        fm.author = value;
        break;
      case "version":
        fm.version = Number(value) || 1;
        break;
      case "created_by":
        fm.created_by = value;
        break;
      case "created_at":
        fm.created_at = value;
        break;
      case "updated_at":
        fm.updated_at = value;
        break;
      case "contributors":
      case "source_sessions": {
        const list: string[] = [];
        if (value && value !== "[]") {
          // inline value rare; parse if present
        }
        let j = i + 1;
        while (j < lines.length && lines[j]?.startsWith("  - ")) {
          list.push(lines[j]!.slice(4).trim());
          j++;
        }
        if (key === "contributors") fm.contributors = list;
        else fm.source_sessions = list;
        i = j - 1;
        break;
      }
    }
    i++;
  }

  if (!fm.name || !fm.description || !fm.author || !fm.created_at) {
    return { fm: null, body };
  }
  return {
    fm: {
      name: fm.name,
      description: fm.description,
      trigger: fm.trigger,
      author: fm.author,
      contributors: fm.contributors ?? [],
      source_sessions: fm.source_sessions ?? [],
      version: fm.version ?? 1,
      created_by: fm.created_by ?? "distill",
      created_at: fm.created_at,
      updated_at: fm.updated_at ?? fm.created_at,
    },
    body,
  };
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export interface WriteNewSkillInput {
  skillsRoot?: string;
  name: string;
  description: string;
  trigger?: string;
  body: string;
  sourceSessions: string[];
  author: string;
}

export function writeNewSkill(input: WriteNewSkillInput): { path: string; version: number } {
  const root = input.skillsRoot ?? SKILLS_ROOT;
  assertValidName(input.name);
  const path = skillPath(root, input.name);
  if (existsSync(path)) {
    throw new Error(`skill ${input.name} already exists at ${path}; use mergeSkill`);
  }
  const now = new Date().toISOString();
  const fm: SkillFrontmatter = {
    name: input.name,
    description: oneLine(input.description),
    trigger: input.trigger ? oneLine(input.trigger) : undefined,
    author: input.author,
    contributors: [],
    source_sessions: input.sourceSessions,
    version: 1,
    created_by: "distill",
    created_at: now,
    updated_at: now,
  };
  mkdirSync(join(root, input.name), { recursive: true });
  writeFileSync(path, serializeFrontmatter(fm) + "\n\n" + input.body.trim() + "\n");
  return { path, version: 1 };
}

export interface MergeSkillInput {
  skillsRoot?: string;
  name: string;
  description?: string;
  trigger?: string;
  body: string;
  newSourceSessions: string[];
  editor: string;
}

export function mergeSkill(input: MergeSkillInput): { path: string; version: number } {
  const root = input.skillsRoot ?? SKILLS_ROOT;
  assertValidName(input.name);
  const path = skillPath(root, input.name);
  if (!existsSync(path)) {
    throw new Error(`skill ${input.name} does not exist at ${path}; use writeNewSkill`);
  }
  const raw = readFileSync(path, "utf-8");
  const { fm: existing } = parseFrontmatter(raw);
  if (!existing) {
    throw new Error(`skill ${input.name} has unparseable frontmatter at ${path}`);
  }
  const mergedSources = Array.from(new Set([...existing.source_sessions, ...input.newSourceSessions]));
  const isCrossAuthor = existing.author !== input.editor;
  const contributors = isCrossAuthor
    ? Array.from(new Set([...existing.contributors, input.editor]))
    : existing.contributors;

  const next: SkillFrontmatter = {
    ...existing,
    description: input.description ? oneLine(input.description) : existing.description,
    trigger: input.trigger ? oneLine(input.trigger) : existing.trigger,
    source_sessions: mergedSources,
    contributors,
    version: existing.version + 1,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path, serializeFrontmatter(next) + "\n\n" + input.body.trim() + "\n");
  return { path, version: next.version };
}

export function listExistingSkills(skillsRoot: string = SKILLS_ROOT): ExistingSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const out: ExistingSkill[] = [];
  for (const entry of readdirSync(skillsRoot)) {
    const dir = join(skillsRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const p = join(dir, "SKILL.md");
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    out.push({ name: entry, path: p, frontmatter: fm, body });
  }
  return out;
}
