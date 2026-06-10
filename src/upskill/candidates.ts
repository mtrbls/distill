// Candidate skills: written on first occurrence of a pattern, dormant
// until a later pass sees the pattern recur and PROMOTEs them into the
// live skills directory. They live outside ~/.claude/skills so Claude
// Code never loads them — a candidate costs nothing until it earns
// promotion. The candidate library is the longitudinal memory that
// lets recurrence be detected across passes without ever needing two
// occurrences inside one curator prompt.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { listExistingSkills, type ExistingSkill } from "../skill.ts";

const log = createLogger("candidates");

export const CANDIDATES_ROOT = join(homedir(), ".distill", "candidates");

export function listCandidates(root: string = CANDIDATES_ROOT): ExistingSkill[] {
  return listExistingSkills(root);
}

// Candidates that never recurred get archived, not deleted: keeping
// them is cheap, and a human can still promote one by hand later.
export function expireCandidates(args: {
  root?: string;
  maxAgeDays: number;
  nowMs?: number;
}): string[] {
  const root = args.root ?? CANDIDATES_ROOT;
  const archiveRoot = root + "-archive";
  if (!existsSync(root)) return [];
  const cutoff = (args.nowMs ?? Date.now()) - args.maxAgeDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for (const c of listExistingSkills(root)) {
    const ts = Date.parse(c.frontmatter?.updated_at ?? "");
    if (!Number.isFinite(ts) || ts > cutoff) continue;
    try {
      mkdirSync(archiveRoot, { recursive: true });
      renameSync(join(root, c.name), join(archiveRoot, c.name));
      expired.push(c.name);
    } catch (e) {
      log(`failed to archive candidate ${c.name}: ${(e as Error).message}`);
    }
  }
  if (expired.length > 0) {
    log(`archived ${expired.length} stale candidate(s): ${expired.join(", ")}`);
  }
  return expired;
}
