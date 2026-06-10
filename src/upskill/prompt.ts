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
  const existingBlock = renderSkillBlocks(args.existing, EXISTING_SKILLS_CHAR_BUDGET);
  const candidatesBlock = renderSkillBlocks(candidates, CANDIDATES_CHAR_BUDGET);

  const existingNames = args.existing.map((s) => s.name);
  const updateClause =
    existingNames.length === 0
      ? "UPDATE is FORBIDDEN. There are no active skills to update. Use CREATE, PROMOTE, or SKIP only."
      : `UPDATE is allowed only if your "name" is EXACTLY one of: [${existingNames.join(", ")}].`;

  const candidateNames = candidates.map((s) => s.name);
  const promoteClause =
    candidateNames.length === 0
      ? "PROMOTE is FORBIDDEN. There are no candidate skills yet."
      : `PROMOTE is allowed only if your "name" is EXACTLY one of: [${candidateNames.join(", ")}]. When you PROMOTE, rewrite the body merging the candidate's content with the new evidence.`;

  const activity = args.pairs
    .map(
      (p, i) =>
        `### Turn ${i + 1}\nUSER: ${truncate(p.user, 1200)}\n\nASSISTANT: ${truncate(p.assistant, 1500)}`,
    )
    .join("\n\n");

  return `You are reviewing recent Claude Code activity for the project "${args.project}" and deciding whether it contains a reusable pattern worth capturing as a skill.

Skills work in two tiers. Active skills load into every future session. Candidate skills are dormant records of a pattern seen once; they activate only when a later review sees the pattern recur and promotes them.

Active skills in this scope:
${existingBlock}

Candidate skills (recorded once, dormant, awaiting recurrence):
${candidatesBlock}

Recent activity (${args.pairs.length} prompt/response pairs from ${args.sessionUuids.length} session(s)):
${activity}

Pick one verdict:
- CREATE   record a new candidate from a concrete, reusable lesson in this activity
- PROMOTE  this activity shows a candidate's pattern happening again; activate it
- UPDATE   extend one of the active skills with new evidence
- SKIP     nothing in the activity is worth recording

Rules:
${args.probe
  ? `- This is a first-run probe: find the SINGLE most valuable pattern in this activity and CREATE a skill for it. A near-miss the user caught, a workflow they repeated, a verification they skipped and regretted. Only SKIP if nothing here would genuinely improve future sessions; a mediocre invented skill is worse than none.`
  : `- Default to SKIP for routine activity. A CREATE records a dormant candidate, so one clear occurrence of a reusable lesson is enough — but it must be a lesson that would change how a future session behaves. Skills mined here load for future work on this same project, so project-specific conventions, gotchas, and workflows are squarely in scope; only one-off trivia is not. A lesson does NOT need to apply across projects.`}
- If the activity matches both a candidate and an active skill, prefer UPDATE.
- ${promoteClause}
- ${updateClause}
- Skill names are lowercase-kebab-case (e.g., verify-integrations-before-sweep), 1-63 chars.
- Body style: short sections (When to use / Workflow / Anti-patterns) under 500 words. Match existing-skill style when there is any.
- Description: a single sentence explaining what the skill is for.
- Trigger: a single phrase describing the situation that should activate this skill.

Output a single JSON object and NOTHING ELSE. No prose, no markdown fence, no preamble.

{
  "verdict": "CREATE" | "UPDATE" | "PROMOTE" | "SKIP",
  "name":        "<slug>" | null,
  "description": "<one-line summary>" | null,
  "trigger":     "<one-line trigger>" | null,
  "body":        "<markdown body>" | null,
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
