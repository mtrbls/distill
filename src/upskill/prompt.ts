// Builds the prompt the curator sees. Pure, no I/O.

import type { ExistingSkill } from "../skill.ts";
import { truncate } from "./harvest.ts";
import type { Pair } from "./types.ts";

// Per-skill bodies are capped, but so is the whole section: past the
// budget, skills get listed by name only (UPDATE still covers them).
const EXISTING_SKILLS_CHAR_BUDGET = 24_000;
const CANDIDATES_CHAR_BUDGET = 12_000;
const PER_SKILL_BODY_CAP = 1_500;

export function buildPrompt(args: {
  project: string;
  existing: ExistingSkill[];
  candidates?: ExistingSkill[];
  pairs: Pair[];
  sessionUuids: string[];
  probe?: boolean;
}): string {
  const candidates = args.candidates ?? [];
  const activeNames = args.existing.map((s) => s.name);
  const candidateNames = candidates.map((s) => s.name);

  const activeHeader =
    activeNames.length === 0
      ? "Active skills: (none — UPDATE is not allowed)"
      : `Active skills — UPDATE must name exactly one of: [${activeNames.join(", ")}]`;
  const candidateHeader =
    candidateNames.length === 0
      ? "Candidate skills: (none yet — PROMOTE is not allowed)"
      : `Candidate skills (dormant, each seen once) — PROMOTE must name exactly one of: [${candidateNames.join(", ")}]`;

  const activity = args.pairs
    .map(
      (p, i) =>
        `### Turn ${i + 1}\nUSER: ${truncate(p.user, 1200)}\n\nASSISTANT: ${truncate(p.assistant, 1500)}`,
    )
    .join("\n\n");

  return `You are reviewing recent Claude Code activity for the project "${args.project}". Decide whether it contains a reusable lesson worth capturing as a skill, and answer with ONE JSON verdict.

${activeHeader}
${renderSkillBlocks(args.existing, EXISTING_SKILLS_CHAR_BUDGET)}

${candidateHeader}
${renderSkillBlocks(candidates, CANDIDATES_CHAR_BUDGET)}

Recent activity (${args.pairs.length} prompt/response pairs from ${args.sessionUuids.length} session(s)):
${activity}

Verdicts:
- SKIP     nothing worth recording. Default to SKIP for routine activity.
- CREATE   record a new dormant candidate: one clear occurrence of a lesson that would change how a future session behaves. Trivia, one-off facts, and work already captured as code are not lessons.
- PROMOTE  the activity shows a candidate's pattern happening again; rewrite the body merging the candidate's content with the new evidence.
- UPDATE   extend an active skill that is wrong or missing a step. If the activity matches both a candidate and an active skill, prefer UPDATE.
${args.probe
  ? `\nThis is a first-run probe: find the SINGLE most valuable pattern and CREATE a skill for it. Only SKIP if nothing here would genuinely improve future sessions; a mediocre invented skill is worse than none.\n`
  : ""}
Output a single JSON object and NOTHING ELSE. No prose, no markdown fence, no preamble.

{
  "verdict": "CREATE" | "UPDATE" | "PROMOTE" | "SKIP",
  "name":        "<lowercase-kebab-case, 1-63 chars; for UPDATE/PROMOTE exactly a listed name>" | null,
  "description": "<one sentence: what the skill is for>" | null,
  "trigger":     "<one phrase: the situation that should activate it>" | null,
  "body":        "<markdown: When to use / Workflow / Anti-patterns, under 500 words>" | null,
  "reason":      "<one-line justification>"
}`;
}

function renderSkillBlocks(skills: ExistingSkill[], budget: number): string {
  if (skills.length === 0) return "(none)";

  const blocks: string[] = [];
  const namesOnly: string[] = [];
  let used = 0;
  for (const s of skills) {
    const block = `--- skill: ${s.name} ---\n${(s.body || "").slice(0, PER_SKILL_BODY_CAP)}`;
    if (used + block.length > budget) {
      namesOnly.push(s.name);
      continue;
    }
    used += block.length;
    blocks.push(block);
  }
  if (namesOnly.length > 0) {
    blocks.push(
      `(${namesOnly.length} more skill(s), bodies omitted for space: ${namesOnly.join(", ")})`,
    );
  }
  return blocks.join("\n");
}
