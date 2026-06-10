// Builds the OTLP logs payload for one upskill run. Every attribute
// is scrubbed against an allowlist at the emission boundary: counts,
// durations, and enums only.

import { VERSION } from "../version.ts";
import { readConfig } from "./config.ts";
import { msToUnixNano, type LogsPayload } from "./telemetry.ts";
import type { Verdict } from "./types.ts";

export interface PhaseTrace {
  name: string;
  durationMs: number;
  attrs: Record<string, unknown>;
  status: "ok" | "error";
}

// Anything not listed here gets dropped. Phase attrs are scrubbed
// against this set before being prefixed with the phase name.
const SOLO_ATTR_ALLOWLIST = new Set([
  // phase attrs
  "scanned",
  "eligible",
  "pairs",
  "char_count",
  "prompt_chars",
  "curator_latency_ms",
  "response_chars",
  "parsed",
  "verdict_enum",
  "op",
  "succeeded",
  "ms_since_last_run",
  "error_type",
  // run-level attrs
  "distill.scanned",
  "distill.pairs",
  "distill.verdict_enum",
  "distill.duration_ms",
  // telemetry test record
  "test",
]);

export function buildRunRecord(args: {
  startedAtMs: number;
  durationMs: number;
  phases: PhaseTrace[];
  verdict: Verdict | null;
}): LogsPayload {
  const cfg = readConfig();

  const attrs: Record<string, unknown> = scrubAttrs({
    "distill.scanned": pickPhase(args.phases, "discover")?.attrs.scanned ?? 0,
    "distill.pairs": pickPhase(args.phases, "harvest")?.attrs.pairs ?? 0,
    "distill.verdict_enum": args.verdict?.verdict ?? "NONE",
    "distill.duration_ms": args.durationMs,
  });

  for (const p of args.phases) {
    attrs[`${p.name}.duration_ms`] = p.durationMs;
    if (p.status === "error") attrs[`${p.name}.error`] = true;
    for (const [k, v] of Object.entries(scrubAttrs(p.attrs))) {
      attrs[`${p.name}.${k}`] = v;
    }
  }

  return {
    resource: buildResource(cfg.telemetry.install_id, cfg.team ? "team" : "solo"),
    scope: { name: "distill", version: VERSION },
    records: [
      {
        body: "distill.upskill",
        timeUnixNano: msToUnixNano(args.startedAtMs),
        attributes: attrs,
      },
    ],
  };
}

function pickPhase(phases: PhaseTrace[], name: string): PhaseTrace | undefined {
  return phases.find((p) => p.name === name);
}

// exported for tests
export function scrubAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (SOLO_ATTR_ALLOWLIST.has(k)) out[k] = v;
  }
  return out;
}

function buildResource(installId: string, mode: "solo" | "team"): Record<string, unknown> {
  return {
    "service.name": "distill",
    "service.version": VERSION,
    "process.runtime.name": "bun",
    "process.runtime.version": typeof Bun !== "undefined" ? (Bun as { version?: string }).version ?? "unknown" : "unknown",
    "os.type": process.platform,
    "os.arch": process.arch,
    "distill.install_id": installId,
    "distill.mode": mode,
  };
}

// ---------- minimal record for `distill telemetry test` ----------

export function buildTestRecord(): LogsPayload {
  const cfg = readConfig();
  return {
    resource: buildResource(cfg.telemetry.install_id, cfg.team ? "team" : "solo"),
    scope: { name: "distill", version: VERSION },
    records: [
      {
        body: "distill.telemetry_test",
        timeUnixNano: msToUnixNano(Date.now()),
        attributes: { test: true },
      },
    ],
  };
}
