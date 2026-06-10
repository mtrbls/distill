// Hand-rolled OTLP/HTTP/JSON exporter, logs flavor: Plouto serves
// POST /api/otel/v1/logs and nothing else. Fire-and-forget, no
// retries, failures only ever land in the file log.
// https://opentelemetry.io/docs/specs/otlp/#otlphttp

import { createLogger } from "../log.ts";
import type { TelemetryDecision } from "./config.ts";

const log = createLogger("telemetry");

const DEFAULT_TIMEOUT_MS = 5000;

export interface LogRecord {
  body: string;
  timeUnixNano: bigint;
  attributes: Record<string, unknown>;
}

export interface LogsPayload {
  resource: Record<string, unknown>;
  scope: { name: string; version: string };
  records: LogRecord[];
}

export async function emitLogs(args: {
  payload: LogsPayload;
  decision: TelemetryDecision;
}): Promise<void> {
  if (!args.decision.emit) {
    log(`skipping emit: ${args.decision.reason}`);
    return;
  }
  const timeoutMs = Number(process.env.DISTILL_TELEMETRY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(buildOtlpLogsJson(args.payload));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (args.decision.token) {
      headers["Authorization"] = `Bearer ${args.decision.token}`;
    }
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
    if (msg.includes("abort")) {
      log(`timeout after ${timeoutMs}ms`);
    } else {
      log(`fetch failed: ${msg}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- JSON-OTLP encoder (ExportLogsServiceRequest) ----------

function buildOtlpLogsJson(payload: LogsPayload): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: kvList(payload.resource) },
        scopeLogs: [
          {
            scope: payload.scope,
            logRecords: payload.records.map((r) => ({
              timeUnixNano: r.timeUnixNano.toString(),
              observedTimeUnixNano: r.timeUnixNano.toString(),
              severityNumber: 9, // INFO
              body: { stringValue: r.body },
              attributes: kvList(r.attributes),
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

// ---------- time helpers ----------

export function msToUnixNano(ms: number): bigint {
  return BigInt(Math.floor(ms)) * 1_000_000n;
}
