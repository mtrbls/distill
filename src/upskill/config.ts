// Persistent settings for distill.
//
// ~/.distill/config.json is the source of truth for telemetry on/off,
// endpoint override, install-id, first-run-notice state, and mode
// (solo or team).
//
// Opt-out resolution lives here too. Order matters:
//   DO_NOT_TRACK > DISTILL_TELEMETRY=0 > --no-telemetry flag > config.enabled
// then endpoint resolution:
//   OTEL_EXPORTER_OTLP_ENDPOINT > config.endpoint_override > team endpoint > default

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";

const log = createLogger("config");

const DISTILL_HOME = join(homedir(), ".distill");
const CONFIG_PATH = join(DISTILL_HOME, "config.json");

export const DEFAULT_OTEL_ENDPOINT = "https://otel.plouto.ai/v1/traces";

const CURRENT_VERSION = 1;

export interface TelemetryConfig {
  enabled: boolean;
  endpoint_override: string | null;
  install_id: string;
  first_run_notice_shown: boolean;
  team_consent_at?: string;
}

export interface TeamConfig {
  id: string;
  name: string;
  git_remote: string;
  otel_endpoint: string;
}

export interface DistillConfig {
  version: number;
  telemetry: TelemetryConfig;
  mode: "solo" | "team";
  team: TeamConfig | null;
}

export interface TelemetryDecision {
  emit: boolean;
  endpoint: string;
  reason: string;
}

// ---------- install-id (UUIDv4 without external deps) ----------

function generateInstallId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function defaults(): DistillConfig {
  return {
    version: CURRENT_VERSION,
    telemetry: {
      enabled: true,
      endpoint_override: null,
      install_id: generateInstallId(),
      first_run_notice_shown: false,
    },
    mode: "solo",
    team: null,
  };
}

// ---------- read / write ----------

export function readConfig(): DistillConfig {
  if (!existsSync(CONFIG_PATH)) {
    const fresh = defaults();
    writeConfig(fresh);
    return fresh;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<DistillConfig>;
    const tel = (raw.telemetry ?? {}) as Partial<TelemetryConfig>;
    return {
      version: typeof raw.version === "number" ? raw.version : CURRENT_VERSION,
      telemetry: {
        enabled: typeof tel.enabled === "boolean" ? tel.enabled : true,
        endpoint_override: tel.endpoint_override ?? null,
        install_id: typeof tel.install_id === "string" && tel.install_id.length > 0
          ? tel.install_id
          : generateInstallId(),
        first_run_notice_shown: !!tel.first_run_notice_shown,
        team_consent_at: tel.team_consent_at,
      },
      mode: raw.mode === "team" ? "team" : "solo",
      team: raw.team ?? null,
    };
  } catch (e) {
    log(`failed to read ${CONFIG_PATH}: ${(e as Error).message}, using defaults`);
    return defaults();
  }
}

export function writeConfig(cfg: DistillConfig): void {
  try {
    mkdirSync(DISTILL_HOME, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...cfg, version: CURRENT_VERSION }, null, 2) + "\n",
    );
  } catch (e) {
    log(`failed to write ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

// ---------- opt-out / endpoint resolution ----------

export function resolveTelemetry(args: { noTelemetryFlag?: boolean } = {}): TelemetryDecision {
  if (process.env.DO_NOT_TRACK === "1") {
    return { emit: false, endpoint: "", reason: "DO_NOT_TRACK=1" };
  }
  if (process.env.DISTILL_TELEMETRY === "0") {
    return { emit: false, endpoint: "", reason: "DISTILL_TELEMETRY=0" };
  }
  if (args.noTelemetryFlag) {
    return { emit: false, endpoint: "", reason: "--no-telemetry" };
  }
  const cfg = readConfig();
  if (!cfg.telemetry.enabled) {
    return { emit: false, endpoint: "", reason: "disabled in config" };
  }
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint =
    (envEndpoint && envEndpoint.length > 0)
      ? envEndpoint
      : cfg.telemetry.endpoint_override
        ?? (cfg.mode === "team" && cfg.team ? cfg.team.otel_endpoint : DEFAULT_OTEL_ENDPOINT);
  return { emit: true, endpoint, reason: `enabled (mode=${cfg.mode})` };
}

// ---------- setters used by `distill telemetry` subcommand ----------

export function setTelemetryEnabled(enabled: boolean): void {
  const cfg = readConfig();
  cfg.telemetry.enabled = enabled;
  writeConfig(cfg);
}

export function setEndpointOverride(url: string | null): void {
  const cfg = readConfig();
  cfg.telemetry.endpoint_override = url;
  writeConfig(cfg);
}

export function resetInstallId(): string {
  const cfg = readConfig();
  const id = generateInstallId();
  cfg.telemetry.install_id = id;
  writeConfig(cfg);
  return id;
}

export function markFirstRunNoticeShown(): void {
  const cfg = readConfig();
  cfg.telemetry.first_run_notice_shown = true;
  writeConfig(cfg);
}
