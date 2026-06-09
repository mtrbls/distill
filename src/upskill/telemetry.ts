// OTLP/HTTP/JSON exporter.
//
// Hand-rolled wire-format encoder + fire-and-forget POST. No npm deps.
// Best-effort: failures land in the file log and the agent moves on.
// Never retries; never blocks; never throws upstream.
//
// Wire spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp
// JSON encoding: a straight JSON of the OTLP protobuf schema.

import { createLogger } from "../log.ts";
import type { TelemetryDecision } from "./config.ts";

const log = createLogger("telemetry");

const DEFAULT_TIMEOUT_MS = 5000;

// ---------- types ----------

export type SpanStatus = "ok" | "error";

export interface SpanData {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  attributes: Record<string, unknown>;
  status: SpanStatus;
}

export interface TraceData {
  traceId: string;
  resource: Record<string, unknown>;
  scope: { name: string; version: string };
  spans: SpanData[];
}

// ---------- emit ----------

export async function emitTrace(args: {
  trace: TraceData;
  decision: TelemetryDecision;
}): Promise<void> {
  if (!args.decision.emit) {
    log(`skipping emit: ${args.decision.reason}`);
    return;
  }
  const timeoutMs = Number(process.env.DISTILL_TELEMETRY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(buildOtlpJson(args.trace));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const headerCsv = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (headerCsv) {
      for (const kv of headerCsv.split(",")) {
        const [k, v] = kv.split("=");
        if (k && v) headers[k.trim()] = v.trim();
      }
    }
    const resp = await fetch(args.decision.endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      log(`endpoint returned ${resp.status} ${resp.statusText}`);
      return;
    }
    log(`ok: ${args.decision.endpoint} (${body.length} bytes)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("aborted")) {
      log(`timeout after ${timeoutMs}ms`);
    } else {
      log(`fetch failed: ${msg}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- JSON-OTLP encoder ----------

function buildOtlpJson(trace: TraceData): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: kvList(trace.resource) },
        scopeSpans: [
          {
            scope: trace.scope,
            spans: trace.spans.map((s) => ({
              traceId: trace.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: s.startUnixNano.toString(),
              endTimeUnixNano: s.endUnixNano.toString(),
              status: { code: s.status === "ok" ? 1 : 2 },
              attributes: kvList(s.attributes),
            })),
          },
        ],
      },
    ],
  };
}

function kvList(map: Record<string, unknown>): unknown[] {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function anyValue(v: unknown): unknown {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { intValue: v };
    return { doubleValue: v };
  }
  if (typeof v === "bigint") return { intValue: v.toString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((x) => anyValue(x)) } };
  }
  if (v && typeof v === "object") {
    return {
      kvlistValue: {
        values: Object.entries(v as Record<string, unknown>).map(([k, val]) => ({
          key: k,
          value: anyValue(val),
        })),
      },
    };
  }
  return { stringValue: String(v) };
}

// ---------- id + time helpers ----------

export function newTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowUnixNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export function msToUnixNano(ms: number): bigint {
  return BigInt(ms) * 1_000_000n;
}
