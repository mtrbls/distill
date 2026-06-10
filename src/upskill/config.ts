// ~/.distill/config.json. Opt-out precedence:
//   DO_NOT_TRACK > DISTILL_TELEMETRY=0 > --no-telemetry > config.enabled
// Pipeline telemetry only has a receiver when connected to Plouto
// (Plouto's OTLP endpoint is bearer-authed), so emission additionally
// requires a connection. OTEL_EXPORTER_OTLP_ENDPOINT overrides the
// target for users with their own collector.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";

const log = createLogger("config");

const DISTILL_HOME = join(homedir(), ".distill");
const CONFIG_PATH = join(DISTILL_HOME, "config.json");

const OTEL_LOGS_PATH = "/api/otel/v1/logs";

const CURRENT_VERSION = 1;

export interface TelemetryConfig {
  enabled: boolean;
  install_id: string;
}

export interface TeamConfig {
  id: string; // uuid; the checkout dir name, and the future Plouto workspace mapping hook
  name: string; // display only, derived from the remote url
  remote: string;
  checkout: string;
  joined_at: string;
  projects?: string[]; // encoded session-dir names; empty = share from anywhere
}

export interface PloutoConfig {
  api_url: string;
  token: string;
  connected_at: string;
  last_synced_at: string | null;
}

export interface DistillConfig {
  version: number;
  telemetry: TelemetryConfig;
  team: TeamConfig | null;
  plouto: PloutoConfig | null;
}

export interface TelemetryDecision {
  emit: boolean;
  endpoint: string;
  token: string | null;
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
      install_id: generateInstallId(),
    },
    team: null,
    plouto: null,
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
        install_id: typeof tel.install_id === "string" && tel.install_id.length > 0
          ? tel.install_id
          : generateInstallId(),
      },
      team: raw.team ?? null,
      plouto: raw.plouto ?? null,
    };
  } catch (e) {
    log(`failed to read ${CONFIG_PATH}: ${(e as Error).message}, using defaults`);
    return defaults();
  }
}

export function writeConfig(cfg: DistillConfig): void {
  try {
    mkdirSync(DISTILL_HOME, { recursive: true });
    // config can hold a bearer token, keep it user-only. The mode
    // option only applies on create, so chmod the existing file too.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...cfg, version: CURRENT_VERSION }, null, 2) + "\n",
      { mode: 0o600 },
    );
    chmodSync(CONFIG_PATH, 0o600);
  } catch (e) {
    log(`failed to write ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

export function setPloutoConnection(p: PloutoConfig | null): void {
  const cfg = readConfig();
  cfg.plouto = p;
  writeConfig(cfg);
}

export function setTeam(t: TeamConfig | null): void {
  const cfg = readConfig();
  cfg.team = t;
  writeConfig(cfg);
}

export function advanceSyncWatermark(lastSyncedAt: string): void {
  const cfg = readConfig();
  if (!cfg.plouto) return;
  cfg.plouto.last_synced_at = lastSyncedAt;
  writeConfig(cfg);
}

// ---------- opt-out / endpoint resolution ----------

export function resolveTelemetry(args: { noTelemetryFlag?: boolean } = {}): TelemetryDecision {
  if (process.env.DO_NOT_TRACK === "1") {
    return { emit: false, endpoint: "", token: null, reason: "DO_NOT_TRACK=1" };
  }
  if (process.env.DISTILL_TELEMETRY === "0") {
    return { emit: false, endpoint: "", token: null, reason: "DISTILL_TELEMETRY=0" };
  }
  if (args.noTelemetryFlag) {
    return { emit: false, endpoint: "", token: null, reason: "--no-telemetry" };
  }
  const cfg = readConfig();
  if (!cfg.telemetry.enabled) {
    return { emit: false, endpoint: "", token: null, reason: "disabled in config" };
  }
  const envEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (envEndpoint && envEndpoint.length > 0) {
    // user-supplied collector: no auth, their infrastructure
    return { emit: true, endpoint: envEndpoint, token: null, reason: "custom collector" };
  }
  if (!cfg.plouto?.token) {
    // Plouto's OTLP endpoint is bearer-authed; without a connection
    // there is nowhere to send
    return { emit: false, endpoint: "", token: null, reason: "not connected" };
  }
  return {
    emit: true,
    endpoint: `${cfg.plouto.api_url.replace(/\/$/, "")}${OTEL_LOGS_PATH}`,
    token: cfg.plouto.token,
    reason: "connected",
  };
}

// ---------- setters used by `distill telemetry` subcommand ----------

export function setTelemetryEnabled(enabled: boolean): void {
  const cfg = readConfig();
  cfg.telemetry.enabled = enabled;
  writeConfig(cfg);
}

export function resetInstallId(): string {
  const cfg = readConfig();
  const id = generateInstallId();
  cfg.telemetry.install_id = id;
  writeConfig(cfg);
  return id;
}

