// discover -> harvest -> curate -> apply -> advance watermark

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { listExistingSkills, SKILLS_ROOT } from "../skill.ts";
import { applyVerdict, gitEmailFallback } from "./apply.ts";
import { CANDIDATES_ROOT, expireCandidates, listCandidates } from "./candidates.ts";
import { resolveTelemetry } from "./config.ts";
import { runCurator } from "./curator.ts";
import { findCandidates } from "./discover.ts";
import { extractPairs } from "./harvest.ts";
import { buildRunRecord, type PhaseTrace } from "./payload.ts";
import { buildPrompt } from "./prompt.ts";
import { advanceWatermark, readWatermark } from "./state.ts";
import { emitLogs } from "./telemetry.ts";
import {
  DEFAULT_CONFIG,
  type UpskillOptions,
  type UpskillResult,
} from "./types.ts";
import { parseVerdict } from "./verdict.ts";

const log = createLogger("upskill");

const SESSIONS_ROOT = join(homedir(), ".claude", "projects");

export async function upskill(opts: UpskillOptions = {}): Promise<UpskillResult> {
  const sessionsRoot = opts.sessionsRoot ?? SESSIONS_ROOT;
  const skillsRoot = opts.skillsRoot ?? SKILLS_ROOT;
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const force = !!opts.force;
  const author = opts.author ?? gitEmailFallback();

  log(`run: sessionsRoot=${sessionsRoot} force=${force}`);

  const startedAtMs = Date.now();
  const phases: PhaseTrace[] = [];
  const decision = resolveTelemetry({ noTelemetryFlag: opts.noTelemetry });

  async function finish(result: UpskillResult): Promise<UpskillResult> {
    // emitLogs logs whether it emitted or skipped, so always call it
    try {
      const payload = buildRunRecord({
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        phases,
        verdict: result.verdict,
      });
      // fire and forget, main() lets the event loop drain this
      emitLogs({ payload, decision }).catch((e) => {
        log(`emitLogs promise rejected: ${(e as Error).message}`);
      });
    } catch (e) {
      log(`record build failed: ${(e as Error).message}`);
    }
    return result;
  }

  // 1. Discover
  const t0 = Date.now();
  const watermark = readWatermark();
  const eligible = findCandidates({
    sessionsRoot,
    watermark,
    config,
    force,
    triggerPath: opts.triggerTranscript,
  });
  // one pass mines one project: the prompt is labeled with a single
  // project and the skill lands in a single repo, so evidence from
  // other projects must not leak in. Scope to the newest session's
  // project; the single watermark still advances over the full set
  // (per-project watermarks are the planned successor).
  const candidates = eligible.filter((c) => c.dir === eligible[0]?.dir);
  if (candidates.length < eligible.length) {
    log(
      `scoped to ${candidates[0]!.project}: ${candidates.length}/${eligible.length} eligible session(s), other projects' sessions skipped this pass`,
    );
  }
  phases.push({
    name: "discover",
    durationMs: Date.now() - t0,
    attrs: { scanned: candidates.length },
    status: "ok",
  });

  if (candidates.length === 0) {
    return finish({
      phase: "discovery",
      scanned: 0,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no new sessions to mine",
    });
  }

  // 2. Harvest (pairs + every cwd the transcripts recorded, one read)
  const t1 = Date.now();
  const { pairs, cwds } = extractPairs({ candidates, config });
  phases.push({
    name: "harvest",
    durationMs: Date.now() - t1,
    attrs: { pairs: pairs.length },
    status: "ok",
  });

  if (pairs.length === 0) {
    advanceWatermark(candidates);
    return finish({
      phase: "extraction",
      scanned: candidates.length,
      pairs: 0,
      verdict: null,
      skillPath: null,
      reason: "no extractable prompt/response pairs",
    });
  }

  // 3. Prompt + Curate + Verdict
  const t2 = Date.now();
  // embedded model: skills mined from a git project land in that
  // project's .claude/skills/ (committed and reviewed like code, and
  // teammates receive them through the pull they already do). The
  // global dir keeps cross-project skills and non-repo work.
  // NOTE: a separate/global team skills repo may come back later for
  // teams whose skills span many codebases.
  // resolve every cwd the mined sessions recorded to a project root.
  // Exactly one root -> embed there. More than one -> the evidence
  // spans projects, and writing it into either ledger could leak one
  // project's lessons into another's git history: fall back to the
  // global dirs, which are private to this machine.
  const roots = new Set<string>();
  for (const cwd of cwds) {
    const r = findRepoRoot(cwd);
    if (r) roots.add(r);
  }
  if (roots.size > 1) {
    log(`evidence spans ${roots.size} projects (${[...roots].join(", ")}); placing globally`);
  }
  const projectRoot = roots.size === 1 ? [...roots][0]! : null;
  const targetRoot = projectRoot
    ? join(projectRoot, ".claude", "skills")
    : skillsRoot;
  // the candidate ledger lives next to the skills it feeds: in the
  // repo it is shared via git, so one teammate's sighting plus
  // another's adds up to a promotion
  const candidatesRoot =
    opts.candidatesRoot ??
    (projectRoot ? join(projectRoot, ".claude", "skill-candidates") : CANDIDATES_ROOT);
  if (targetRoot !== skillsRoot) log(`target: ${targetRoot} (project-embedded)`);
  const existing = [
    ...listExistingSkills(skillsRoot),
    ...(targetRoot !== skillsRoot ? listExistingSkills(targetRoot) : []),
  ];
  expireCandidates({ root: candidatesRoot, maxAgeDays: config.candidateExpiryDays });
  const candidateSkills = listCandidates(candidatesRoot);
  const prompt = buildPrompt({
    project: candidates[0]!.project,
    existing,
    candidates: candidateSkills,
    pairs,
    sessionUuids: candidates.map((c) => c.sessionUuid),
    probe: opts.probe,
  });
  phases.push({
    name: "prompt",
    durationMs: Date.now() - t2,
    attrs: { prompt_chars: prompt.length },
    status: "ok",
  });
  log(`curator prompt: ${prompt.length} chars`);

  const t3 = Date.now();
  const { stdout, error } = await runCurator({ prompt, config });
  phases.push({
    name: "curate",
    durationMs: Date.now() - t3,
    attrs: {
      curator_latency_ms: Date.now() - t3,
      response_chars: stdout.length,
      error_type: error ? "claude_exit_nonzero" : undefined,
    },
    status: error ? "error" : "ok",
  });

  if (error) {
    advanceWatermark(candidates);
    return finish({
      phase: "curation",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `curator failed: ${error.slice(0, 200)}`,
    });
  }

  const t4 = Date.now();
  const verdict = parseVerdict(stdout);
  phases.push({
    name: "verdict",
    durationMs: Date.now() - t4,
    attrs: {
      parsed: !!verdict,
      verdict_enum: verdict?.verdict ?? "UNPARSEABLE",
    },
    status: verdict ? "ok" : "error",
  });

  if (!verdict) {
    advanceWatermark(candidates);
    return finish({
      phase: "curation",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `verdict unparseable from curator output (${stdout.length} chars)`,
    });
  }

  // 4. Apply
  const t5 = Date.now();
  const applied = applyVerdict({
    verdict,
    candidates,
    skillsRoot: targetRoot,
    candidatesRoot,
    author,
    probe: opts.probe,
  });
  phases.push({
    name: "apply",
    durationMs: Date.now() - t5,
    attrs: {
      op: verdict.verdict.toLowerCase(),
      succeeded: applied.ok,
      error_type: applied.ok ? undefined : "apply_failed",
    },
    status: applied.ok ? "ok" : "error",
  });

  // 5. Advance watermark (always)
  const t6 = Date.now();
  advanceWatermark(candidates);
  phases.push({
    name: "state.advance",
    durationMs: Date.now() - t6,
    attrs: {
      ms_since_last_run: watermark.lastDate
        ? Date.now() - Date.parse(watermark.lastDate)
        : -1,
    },
    status: "ok",
  });

  return finish({
    phase: "done",
    scanned: candidates.length,
    pairs: pairs.length,
    verdict,
    skillPath: applied.skillPath,
    tier: applied.tier,
    dirs: candidates.map((c) => c.dir ?? ""),
    reason: applied.reason || verdict.reason || "",
  });
}

// Work done in a git repo embeds its skills in that repo; nothing to
// configure. The walk finds the nearest ancestor with .git (a dir, or
// a file in worktrees/submodules). $HOME is a CEILING: the walk stops
// there, so neither a dotfiles repo at home nor anything above it
// (/Users/.git on a shared box) can capture every session under it.
export function findRepoRoot(dir: string, home: string = homedir()): string | null {
  let d = dir;
  while (true) {
    if (d === home) return null;
    if (existsSync(join(d, ".git"))) return d;
    const parent = join(d, "..");
    if (parent === d) return null;
    d = parent;
  }
}

