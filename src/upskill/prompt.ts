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
