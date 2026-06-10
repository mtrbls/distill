// The prompt sent TO the curator.
//
// Pure function. No I/O, no async, no side effects. Given existing
// skills, recent activity pairs, and project metadata, returns the
// string the curator LLM sees.
//
// Reused at v0.2 by the eval engine to build replay prompts.

import type { ExistingSkill } from "../skill.ts";
import { truncate } from "./harvest.ts";
import type { Pair } from "./types.ts";

// Total char budget for the existing-skills section. Per-skill bodies
// are capped at 1500 chars; without a total cap the section grows
// unbounded with the user's skill count (17 skills ≈ 25k chars; 100
// skills would dwarf the activity evidence). Skills past the budget
// are listed by name only — the UPDATE constraint still covers them.
const EXISTING_SKILLS_CHAR_BUDGET = 24_000;
const PER_SKILL_BODY_CAP = 1_500;

export function buildPrompt(args: {
  project: string;
  existing: ExistingSkill[];
  pairs: Pair[];
  sessionUuids: string[];
}): string {
  const existingBlock = renderExistingSkills(args.existing);

  const existingNames = args.existing.map((s) => s.name);
  const updateClause =
    existingNames.length === 0
      ? "UPDATE is FORBIDDEN. There are no existing skills to update. Use CREATE or SKIP only."
      : `UPDATE is allowed only if your "name" is EXACTLY one of: [${existingNames.join(", ")}]. Any other name MUST use CREATE, not UPDATE.`;

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
- CREATE  write a new skill from a pattern not already covered
- UPDATE  extend one of the existing skills with new evidence
- SKIP    nothing in the activity warrants a skill

Rules:
- Default to SKIP. A skill captures a recurring pattern, not a single observation. Single mistakes are not skills.
- ${updateClause}
- Skill names are lowercase-kebab-case (e.g., verify-integrations-before-sweep), 1-63 chars.
- Body style: short sections (When to use / Workflow / Anti-patterns) under 500 words. Match existing-skill style when there is any.
- Description: a single sentence explaining what the skill is for.
- Trigger: a single phrase describing the situation that should activate this skill.

Output a single JSON object and NOTHING ELSE. No prose, no markdown fence, no preamble.

{
  "verdict": "CREATE" | "UPDATE" | "SKIP",
  "name":        "<slug>" | null,
  "description": "<one-line summary>" | null,
  "trigger":     "<one-line trigger>" | null,
  "body":        "<markdown body>" | null,
  "reason":      "<one-line justification>"
}`;
}

function renderExistingSkills(existing: ExistingSkill[]): string {
  if (existing.length === 0) return "(no existing skills in this scope)";

  const blocks: string[] = [];
  const namesOnly: string[] = [];
  let used = 0;
  for (const s of existing) {
    const block = `--- skill: ${s.name} ---\n${(s.body || "").slice(0, PER_SKILL_BODY_CAP)}`;
    if (used + block.length > EXISTING_SKILLS_CHAR_BUDGET) {
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
