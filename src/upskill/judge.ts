import { createLogger } from "../log.ts";
import type { ExistingSkill } from "../skill.ts";
import { truncate } from "./harvest.ts";
import type { Pair, UpskillConfig, Verdict } from "./types.ts";

const log = createLogger("judge");

// ---------- prompt ----------

export function buildPrompt(args: {
  project: string;
  existing: ExistingSkill[];
  pairs: Pair[];
  sessionUuids: string[];
}): string {
  const existingBlock =
    args.existing.length === 0
      ? "(no existing skills in this scope)"
      : args.existing
          .map((s) => `--- skill: ${s.name} ---\n${(s.body || "").slice(0, 1500)}`)
          .join("\n");

  const existingNames = args.existing.map((s) => s.name);
  const mergeClause =
    existingNames.length === 0
      ? "MERGE is FORBIDDEN. There are no existing skills to merge into. Use KEEP or SKIP only."
      : `MERGE is allowed only if your "name" is EXACTLY one of: [${existingNames.join(", ")}]. Any other name MUST use KEEP, not MERGE.`;

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

// ---------- subprocess ----------

export async function runJudge(args: {
  prompt: string;
  config: UpskillConfig;
}): Promise<{ stdout: string; error: string | null }> {
  log(`spawning claude -p (timeout ${args.config.judgeTimeoutMs}ms)`);
  const proc = Bun.spawn(["claude", "-p", args.prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, args.config.judgeTimeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      log(`claude exited ${code}`);
      return { stdout: stdout || "", error: stderr || `claude exited ${code}` };
    }
    log(`claude ok, ${stdout.length} chars`);
    return { stdout, error: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- verdict parser ----------

export function parseVerdict(stdout: string): Verdict | null {
  // Tolerate code fences, leading prose, trailing noise.
  const cleaned = stdout
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
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
