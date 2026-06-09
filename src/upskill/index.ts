// Orchestrator for the upskill pipeline.
//
// Flow:
//   discover  →  harvest  →  judge  →  apply  →  state advance
//
// Each phase is its own module; this file just coordinates them and
// returns a UpskillResult that tells the caller (cli.ts, eventually
// eval.ts) which phase produced the outcome.

import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { listExistingSkills, SKILLS_ROOT } from "../skill.ts";
import { applyVerdict, gitEmailFallback } from "./apply.ts";
import { findCandidates } from "./discover.ts";
import { extractPairs } from "./harvest.ts";
import { runJudge } from "./judge.ts";
import { buildPrompt } from "./prompt.ts";
import { advanceWatermark, readWatermark } from "./state.ts";
import { parseVerdict } from "./verdict.ts";
import {
  DEFAULT_CONFIG,
  type UpskillOptions,
  type UpskillResult,
} from "./types.ts";

const log = createLogger("upskill");

const SESSIONS_ROOT = join(homedir(), ".claude", "projects");

export async function upskill(opts: UpskillOptions = {}): Promise<UpskillResult> {
  const sessionsRoot = opts.sessionsRoot ?? SESSIONS_ROOT;
  const skillsRoot = opts.skillsRoot ?? SKILLS_ROOT;
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const force = !!opts.force;
  const author = opts.author ?? gitEmailFallback();

  log(`run: sessionsRoot=${sessionsRoot} force=${force}`);

  // 1. Discover
  const watermark = readWatermark();
  const candidates = findCandidates({ sessionsRoot, watermark, config, force });

  if (candidates.length === 0) {
    return {
      phase: "discovery",
      scanned: 0,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no new sessions to mine",
    };
  }

  // 2. Harvest
  const pairs = extractPairs({ candidates, config });

  if (pairs.length === 0) {
    advanceWatermark(candidates);
    return {
      phase: "extraction",
      scanned: candidates.length,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no extractable prompt/response pairs",
    };
  }

  // 3. Judge
  const existing = listExistingSkills(skillsRoot);
  const prompt = buildPrompt({
    project: candidates[0]!.project,
    existing,
    pairs,
    sessionUuids: candidates.map((c) => c.sessionUuid),
  });
  log(`judge prompt: ${prompt.length} chars`);

  const { stdout, error } = await runJudge({ prompt, config });
  if (error) {
    advanceWatermark(candidates);
    return {
      phase: "judging",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `judge failed: ${error.slice(0, 200)}`,
    };
  }

  const verdict = parseVerdict(stdout);
  if (!verdict) {
    advanceWatermark(candidates);
    return {
      phase: "judging",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `verdict unparseable from judge output (${stdout.length} chars)`,
    };
  }

  // 4. Apply
  const applied = applyVerdict({ verdict, candidates, skillsRoot, author });

  // 5. State advance (always, regardless of outcome)
  advanceWatermark(candidates);

  return {
    phase: "done",
    scanned: candidates.length,
    pairs: pairs.length,
    verdict,
    skillPath: applied.skillPath,
    reason: applied.reason || verdict.reason || "",
  };
}

// Re-export public types so callers can `import { upskill, UpskillResult }`
// from a single path.
export type {
  Candidate,
  Pair,
  Verdict,
  UpskillConfig,
  UpskillOptions,
  UpskillResult,
} from "./types.ts";
