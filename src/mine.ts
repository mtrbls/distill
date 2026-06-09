import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ExistingSkill, listExistingSkills, mergeSkill, SKILLS_ROOT, writeNewSkill } from "./skill.ts";

const HOME = homedir();
const DISTILL_HOME = join(HOME, ".distill");
const STATE_PATH = join(DISTILL_HOME, "state.json");
const SESSIONS_ROOT = join(HOME, ".claude", "projects");

const SESSIONS_TO_MINE = 5;
const MAX_MSG_PER_SESSION = 60;
const MAX_PROMPT_CHARS = 60_000;
const JUDGE_TIMEOUT_MS = 240_000;
const ACTIVE_SESSION_GRACE_MS = 30_000;

interface Watermark {
  lastDate: string | null;
  lastSessionUuid: string | null;
}

interface Candidate {
  path: string;
  sessionUuid: string;
  project: string;
  mtimeMs: number;
}

interface Pair {
  user: string;
  assistant: string;
}

interface Verdict {
  verdict: "KEEP" | "MERGE" | "SKIP";
  name: string | null;
  description: string | null;
  trigger: string | null;
  body: string | null;
  reason: string | null;
}

export interface MineOptions {
  sessionsRoot?: string;
  skillsRoot?: string;
  sessionsToMine?: number;
  force?: boolean; // ignore watermark
  author?: string;
}

export interface MineResult {
  scanned: number;
  pairs: number;
  verdict: Verdict | null;
  skillPath: string | null;
  reason: string;
}

// ---------- watermark ----------

function readWatermark(): Watermark {
  if (!existsSync(STATE_PATH)) return { lastDate: null, lastSessionUuid: null };
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<Watermark>;
    return {
      lastDate: raw.lastDate ?? null,
      lastSessionUuid: raw.lastSessionUuid ?? null,
    };
  } catch {
    return { lastDate: null, lastSessionUuid: null };
  }
}

function writeWatermark(w: Watermark): void {
  mkdirSync(DISTILL_HOME, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(w, null, 2) + "\n");
}

// ---------- candidates ----------

function findCandidates(
  sessionsRoot: string,
  watermark: Watermark,
  limit: number,
  force: boolean,
): Candidate[] {
  if (!existsSync(sessionsRoot)) return [];
  const candidates: Candidate[] = [];
  const threshold = !force && watermark.lastDate ? Date.parse(watermark.lastDate) : 0;
  const nowGrace = Date.now() - ACTIVE_SESSION_GRACE_MS;

  for (const projectDir of readdirSync(sessionsRoot)) {
    const full = join(sessionsRoot, projectDir);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const p = join(full, file);
      let fs;
      try {
        fs = statSync(p);
      } catch {
        continue;
      }
      if (fs.mtimeMs > nowGrace) continue; // probably active session
      if (fs.mtimeMs <= threshold) continue; // already mined
      const sessionUuid = file.replace(/\.jsonl$/, "");
      candidates.push({
        path: p,
        sessionUuid,
        project: projectDir.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/") || projectDir,
        mtimeMs: fs.mtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit);
}

// ---------- pair extraction ----------

function extractPairs(jsonlPath: string, max: number): Pair[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "user" || obj.type === "assistant") {
      const role: "user" | "assistant" = obj.type;
      const text = extractText(obj.message?.content);
      if (text) messages.push({ role, text });
    }
  }
  // Pair user→assistant in order
  const pairs: Pair[] = [];
  let pendingUser: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      pendingUser = m.text;
    } else if (m.role === "assistant" && pendingUser) {
      pairs.push({ user: pendingUser, assistant: m.text });
      pendingUser = null;
    }
  }
  return pairs.slice(-max); // keep the most recent
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        // include tool name for assistant signal; skip raw input to keep prompt small
        parts.push(`[tool: ${block.name}]`);
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        parts.push(`[tool_result] ${block.content.slice(0, 400)}`);
      }
    }
  }
  return parts.join("\n").trim();
}

// ---------- judge prompt ----------

function buildPrompt(args: {
  project: string;
  existing: ExistingSkill[];
  pairs: Pair[];
  sessionUuids: string[];
}): string {
  const existingBlock =
    args.existing.length === 0
      ? "(no existing skills in this scope)"
      : args.existing
          .map(
            (s) =>
              `--- skill: ${s.name} ---\n${(s.body || "").slice(0, 1500)}`,
          )
          .join("\n");

  const existingNames = args.existing.map((s) => s.name);
  const mergeClause =
    existingNames.length === 0
      ? "MERGE is FORBIDDEN. There are no existing skills to merge into. Use KEEP or SKIP only."
      : `MERGE is allowed only if your \"name\" is EXACTLY one of: [${existingNames.join(", ")}]. Any other name MUST use KEEP, not MERGE.`;

  const activity = args.pairs
    .map(
      (p, i) =>
        `### Turn ${i + 1}\nUSER: ${truncate(p.user, 1200)}\n\nASSISTANT: ${truncate(p.assistant, 1500)}`,
    )
    .join("\n\n");

  return `You are reviewing recent Claude Code activity for the project "${args.project}" and deciding whether it contains a recurring, non-trivial pattern worth capturing as a reusable skill.

Skills already present in this scope:
${existingBlock}

Recent activity (${args.pairs.length} prompt/response pairs from ${args.sessionUuids.length} session(s)):
${activity}

Pick one verdict:
- KEEP   create a new skill from a pattern not already covered
- MERGE  extend one of the existing skills with new evidence
- SKIP   nothing in the activity warrants a skill

Rules:
- Default to SKIP. A skill captures a recurring pattern, not a single observation. Single mistakes are not skills.
- ${mergeClause}
- Skill names are lowercase-kebab-case (e.g., verify-integrations-before-sweep), 1-63 chars.
- Body style: short sections (When to use / Workflow / Anti-patterns) under 500 words. Match existing-skill style when there is any.
- Description: a single sentence explaining what the skill is for.
- Trigger: a single phrase describing the situation that should activate this skill.

Output a single JSON object and NOTHING ELSE. No prose, no markdown fence, no preamble.

{
  "verdict": "KEEP" | "MERGE" | "SKIP",
  "name":        "<slug>" | null,
  "description": "<one-line summary>" | null,
  "trigger":     "<one-line trigger>" | null,
  "body":        "<markdown body>" | null,
  "reason":      "<one-line justification>"
}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + " ...[truncated]";
}

// ---------- judge ----------

async function runJudge(prompt: string): Promise<{ stdout: string; error: string | null }> {
  const proc = Bun.spawn(["claude", "-p", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, JUDGE_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) return { stdout: stdout || "", error: stderr || `claude exited ${code}` };
    return { stdout, error: null };
  } finally {
    clearTimeout(timeout);
  }
}

function parseVerdict(stdout: string): Verdict | null {
  // Find the first { ... } JSON object in the output, tolerating
  // surrounding chatter or markdown fences.
  const cleaned = stdout
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  // Greedy extraction: from first { to matching }
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const blob = cleaned.slice(start, end + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  const v = parsed.verdict;
  if (v !== "KEEP" && v !== "MERGE" && v !== "SKIP") return null;
  return {
    verdict: v,
    name: typeof parsed.name === "string" ? parsed.name : null,
    description: typeof parsed.description === "string" ? parsed.description : null,
    trigger: typeof parsed.trigger === "string" ? parsed.trigger : null,
    body: typeof parsed.body === "string" ? parsed.body : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
  };
}

// ---------- orchestrator ----------

export async function mine(opts: MineOptions = {}): Promise<MineResult> {
  const sessionsRoot = opts.sessionsRoot ?? SESSIONS_ROOT;
  const skillsRoot = opts.skillsRoot ?? SKILLS_ROOT;
  const limit = opts.sessionsToMine ?? SESSIONS_TO_MINE;
  const force = !!opts.force;
  const author = opts.author ?? gitEmailFallback();

  const watermark = readWatermark();
  const candidates = findCandidates(sessionsRoot, watermark, limit, force);

  if (candidates.length === 0) {
    return {
      scanned: 0,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no new sessions to mine",
    };
  }

  // Extract pairs across candidates
  const allPairs: Pair[] = [];
  for (const c of candidates) {
    const pairs = extractPairs(c.path, MAX_MSG_PER_SESSION);
    allPairs.push(...pairs);
  }

  // Hard cap total pair char budget
  let charCount = 0;
  const capped: Pair[] = [];
  for (let i = allPairs.length - 1; i >= 0; i--) {
    const p = allPairs[i]!;
    const size = p.user.length + p.assistant.length;
    if (charCount + size > MAX_PROMPT_CHARS) break;
    charCount += size;
    capped.unshift(p);
  }

  if (capped.length === 0) {
    advanceWatermark(candidates);
    return {
      scanned: candidates.length,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no extractable prompt/response pairs after parsing",
    };
  }

  const existing = listExistingSkills(skillsRoot);
  const project = candidates[0]!.project;

  const prompt = buildPrompt({
    project,
    existing,
    pairs: capped,
    sessionUuids: candidates.map((c) => c.sessionUuid),
  });

  const { stdout, error } = await runJudge(prompt);
  if (error) {
    advanceWatermark(candidates);
    return {
      scanned: candidates.length,
      pairs: capped.length,
      verdict: null,
      skillPath: null,
      reason: `judge failed: ${error.slice(0, 200)}`,
    };
  }

  const verdict = parseVerdict(stdout);
  if (!verdict) {
    advanceWatermark(candidates);
    return {
      scanned: candidates.length,
      pairs: capped.length,
      verdict: null,
      skillPath: null,
      reason: `verdict unparseable from judge output (${stdout.length} chars)`,
    };
  }

  let skillPath: string | null = null;
  const sourceSessions = candidates.map((c) => c.sessionUuid);

  if (verdict.verdict === "KEEP" && verdict.name && verdict.body && verdict.description) {
    try {
      const r = writeNewSkill({
        skillsRoot,
        name: verdict.name,
        description: verdict.description,
        trigger: verdict.trigger ?? undefined,
        body: verdict.body,
        sourceSessions,
        author,
      });
      skillPath = r.path;
    } catch (e: any) {
      advanceWatermark(candidates);
      return {
        scanned: candidates.length,
        pairs: capped.length,
        verdict,
        skillPath: null,
        reason: `writeNewSkill failed: ${e?.message ?? String(e)}`,
      };
    }
  } else if (verdict.verdict === "MERGE" && verdict.name && verdict.body) {
    try {
      const r = mergeSkill({
        skillsRoot,
        name: verdict.name,
        description: verdict.description ?? undefined,
        trigger: verdict.trigger ?? undefined,
        body: verdict.body,
        newSourceSessions: sourceSessions,
        editor: author,
      });
      skillPath = r.path;
    } catch (e: any) {
      // fallback to KEEP if target missing
      const msg = String(e?.message ?? e);
      if (/does not exist/i.test(msg) && verdict.description) {
        try {
          const r = writeNewSkill({
            skillsRoot,
            name: verdict.name,
            description: verdict.description,
            trigger: verdict.trigger ?? undefined,
            body: verdict.body,
            sourceSessions,
            author,
          });
          skillPath = r.path;
        } catch (e2: any) {
          advanceWatermark(candidates);
          return {
            scanned: candidates.length,
            pairs: capped.length,
            verdict,
            skillPath: null,
            reason: `mergeSkill fallback failed: ${e2?.message ?? String(e2)}`,
          };
        }
      } else {
        advanceWatermark(candidates);
        return {
          scanned: candidates.length,
          pairs: capped.length,
          verdict,
          skillPath: null,
          reason: `mergeSkill failed: ${msg.slice(0, 200)}`,
        };
      }
    }
  }

  advanceWatermark(candidates);
  return {
    scanned: candidates.length,
    pairs: capped.length,
    verdict,
    skillPath,
    reason: verdict.reason ?? "",
  };
}

function advanceWatermark(candidates: Candidate[]): void {
  if (candidates.length === 0) return;
  const newest = candidates[0]!;
  writeWatermark({
    lastDate: new Date(newest.mtimeMs).toISOString(),
    lastSessionUuid: newest.sessionUuid,
  });
}

function gitEmailFallback(): string {
  try {
    const proc = Bun.spawnSync(["git", "config", "user.email"]);
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) return out;
  } catch {}
  return "unknown@local";
}
