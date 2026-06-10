// Builds the OTLP payload. Solo mode scrubs every span against an
// allowlist at the emission boundary; team mode (consented) passes
// bodies through.

import { VERSION } from "../version.ts";
import { readConfig } from "./config.ts";
import {
  msToUnixNano,
  newSpanId,
  newTraceId,
  type SpanData,
  type TraceData,
} from "./telemetry.ts";
import type { Verdict } from "./types.ts";

export interface PhaseTrace {
  name: string;
  durationMs: number;
  attrs: Record<string, unknown>;
  status: "ok" | "error";
  bodies?: Record<string, unknown>; // team mode only
}

// Anything not listed here gets dropped in solo mode, root span
// included.
const SOLO_ATTR_ALLOWLIST = new Set([
  // phase span attrs
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
  // root span attrs
  "distill.scanned",
  "distill.pairs",
  "distill.verdict_enum",
  "distill.duration_ms",
  // telemetry test span
  "test",
]);

export function buildTrace(args: {
  startedAtMs: number;
  durationMs: number;
  phases: PhaseTrace[];
  verdict: Verdict | null;
}): TraceData {
  const cfg = readConfig();
  const mode = cfg.mode;

  const traceId = newTraceId();
  const rootSpanId = newSpanId();

  const rootAttrs: Record<string, unknown> = {
    "distill.scanned": pickPhase(args.phases, "discover")?.attrs.scanned ?? 0,
    "distill.pairs": pickPhase(args.phases, "harvest")?.attrs.pairs ?? 0,
    "distill.verdict_enum": args.verdict?.verdict ?? "NONE",
    "distill.duration_ms": args.durationMs,
  };

  const rootSpan: SpanData = {
    name: "upskill",
    spanId: rootSpanId,
    startUnixNano: msToUnixNano(args.startedAtMs),
    endUnixNano: msToUnixNano(args.startedAtMs + args.durationMs),
    attributes: mode === "solo" ? scrubAttrs(rootAttrs) : rootAttrs,
    status: args.phases.some((p) => p.status === "error") ? "error" : "ok",
  };

  const phaseSpans: SpanData[] = [];
  let cursorMs = args.startedAtMs;
  for (const p of args.phases) {
    const start = cursorMs;
    const end = cursorMs + p.durationMs;
    cursorMs = end;

    const baseAttrs = mode === "solo" ? scrubAttrs(p.attrs) : p.attrs;
    const teamAttrs = mode === "team" && p.bodies ? { ...baseAttrs, ...p.bodies } : baseAttrs;

    phaseSpans.push({
      name: p.name,
      spanId: newSpanId(),
      parentSpanId: rootSpanId,
      startUnixNano: msToUnixNano(start),
      endUnixNano: msToUnixNano(end),
      attributes: teamAttrs,
      status: p.status,
    });
  }

  return {
    traceId,
    resource: buildResource(cfg.telemetry.install_id, mode, cfg.team?.id),
    scope: { name: "distill", version: VERSION },
    spans: [rootSpan, ...phaseSpans],
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

function buildResource(
  installId: string,
  mode: "solo" | "team",
  teamId: string | undefined,
): Record<string, unknown> {
  const r: Record<string, unknown> = {
    "service.name": "distill",
    "service.version": VERSION,
    "process.runtime.name": "bun",
    "process.runtime.version": typeof Bun !== "undefined" ? (Bun as { version?: string }).version ?? "unknown" : "unknown",
    "os.type": process.platform,
    "os.arch": process.arch,
    "distill.install_id": installId,
    "distill.mode": mode,
  };
  if (mode === "team" && teamId) {
    r["distill.team.id"] = teamId;
  }
  return r;
}

// ---------- minimal trace for `distill telemetry test` ----------

export function buildTestTrace(): TraceData {
  const cfg = readConfig();
  const traceId = newTraceId();
  const rootSpanId = newSpanId();
  const now = Date.now();
  return {
    traceId,
    resource: buildResource(cfg.telemetry.install_id, cfg.mode, cfg.team?.id),
    scope: { name: "distill", version: VERSION },
    spans: [
      {
        name: "telemetry.test",
        spanId: rootSpanId,
        startUnixNano: msToUnixNano(now - 1),
        endUnixNano: msToUnixNano(now),
        attributes: { test: true },
        status: "ok",
      },
    ],
  };
}
