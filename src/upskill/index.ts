// Orchestrator for the upskill pipeline.
//
// Flow:
//   discover  →  harvest  →  judge  →  apply  →  state advance
//
// Each phase is its own module; this file just coordinates them,
// times them, returns a UpskillResult, and (best-effort) emits an
// OTLP trace at the end via the telemetry exporter.

import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { listExistingSkills, SKILLS_ROOT } from "../skill.ts";
import { applyVerdict, gitEmailFallback } from "./apply.ts";
import { resolveTelemetry } from "./config.ts";
import { findCandidates } from "./discover.ts";
import { extractPairs } from "./harvest.ts";
import { runJudge } from "./judge.ts";
import { buildTrace, type PhaseTrace } from "./payload.ts";
import { buildPrompt } from "./prompt.ts";
import { advanceWatermark, readWatermark } from "./state.ts";
import { emitTrace } from "./telemetry.ts";
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
    // Always call emitTrace; it handles the decision internally and
    // logs whichever path it took (emit or skip). This gives us a
    // full audit trail in the file log regardless of telemetry state.
    try {
      const trace = buildTrace({
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        phases,
        verdict: result.verdict,
      });
      // Fire-and-forget; the outer main() uses process.exitCode (not
      // process.exit) so this can drain on its own time. The exporter
      // has a 5s timeout so it can't hang.
      emitTrace({ trace, decision }).catch((e) => {
        log(`emitTrace promise rejected: ${(e as Error).message}`);
      });
    } catch (e) {
      log(`trace build failed: ${(e as Error).message}`);
    }
    return result;
  }

  // 1. Discover
  const t0 = Date.now();
  const watermark = readWatermark();
  const candidates = findCandidates({ sessionsRoot, watermark, config, force });
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

  // 2. Harvest
  const t1 = Date.now();
  const pairs = extractPairs({ candidates, config });
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

  // 3. Prompt + Judge + Verdict
  const t2 = Date.now();
  const existing = listExistingSkills(skillsRoot);
  const prompt = buildPrompt({
    project: candidates[0]!.project,
    existing,
    pairs,
    sessionUuids: candidates.map((c) => c.sessionUuid),
  });
  phases.push({
    name: "prompt",
    durationMs: Date.now() - t2,
    attrs: { prompt_chars: prompt.length },
    status: "ok",
  });
  log(`judge prompt: ${prompt.length} chars`);

  const t3 = Date.now();
  const { stdout, error } = await runJudge({ prompt, config });
  phases.push({
    name: "judge",
    durationMs: Date.now() - t3,
    attrs: {
      judge_latency_ms: Date.now() - t3,
      response_chars: stdout.length,
      error_type: error ? "claude_exit_nonzero" : undefined,
    },
    status: error ? "error" : "ok",
  });

  if (error) {
    advanceWatermark(candidates);
    return finish({
      phase: "judging",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `judge failed: ${error.slice(0, 200)}`,
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
      phase: "judging",
      scanned: candidates.length,
      pairs: pairs.length,
      verdict: null,
      skillPath: null,
      reason: `verdict unparseable from judge output (${stdout.length} chars)`,
    });
  }

  // 4. Apply
  const t5 = Date.now();
  const applied = applyVerdict({ verdict, candidates, skillsRoot, author });
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

  // 5. State advance (always, regardless of outcome)
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
    reason: applied.reason || verdict.reason || "",
  });
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
