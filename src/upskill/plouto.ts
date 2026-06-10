// Plouto sync client. Posts session/turn metadata (never content) to
// Plouto's existing ingest endpoint, and handles the connect flow that
// mints the bearer token via a localhost browser redirect.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { gitEmailFallback } from "./apply.ts";
import {
  advanceSyncWatermark,
  readConfig,
  setPloutoConnection,
  type PloutoConfig,
} from "./config.ts";
import { extractSession, listSessionFiles, type ExtractedSession } from "./usage.ts";

const log = createLogger("plouto");

export const DEFAULT_PLOUTO_API = "https://api.plouto.ai";
const SYNC_LIMIT = 20;
const SYNC_TIMEOUT_MS = 15_000;
// Plouto rejects ingest bodies over 2 MB; stay well under it
const MAX_BATCH_BYTES = 1_500_000;
const MAX_TURNS_PER_CHUNK = 1_500;
const CONNECT_TIMEOUT_MS = 120_000;
const ACTIVE_SESSION_GRACE_MS = 30_000;

const SESSIONS_ROOT = join(homedir(), ".claude", "projects");

// ---------- payload assembly ----------

export interface IngestRequest {
  provider_kind: "claude_code";
  sessions: unknown[];
  turns: unknown[];
  errors: unknown[];
  agent_identity: { email: string; display_name: string } | null;
}

export function assembleIngestRequest(
  extracted: ExtractedSession[],
  email: string,
): IngestRequest {
  return {
    provider_kind: "claude_code",
    sessions: extracted.map((e) => e.session),
    turns: extracted.flatMap((e) => e.turns),
    errors: [],
    agent_identity: email ? { email, display_name: email.split("@")[0] ?? email } : null,
  };
}

// ---------- sync ----------

export interface SyncResult {
  ok: boolean;
  sessionsSynced: number;
  sessionsUpserted: number;
  turnsUpserted: number;
  reason: string;
}

export async function syncRecent(opts: { sessionsRoot?: string } = {}): Promise<SyncResult> {
  const cfg = readConfig();
  if (!cfg.plouto?.token) {
    return { ok: false, sessionsSynced: 0, sessionsUpserted: 0, turnsUpserted: 0, reason: "not connected" };
  }

  const root = opts.sessionsRoot ?? SESSIONS_ROOT;
  const since = cfg.plouto.last_synced_at ? Date.parse(cfg.plouto.last_synced_at) : 0;
  const activeGrace = Date.now() - ACTIVE_SESSION_GRACE_MS;

  // oldest first so the watermark can advance per successful batch
  const files = listSessionFiles(root, since)
    .map((p) => ({ p, mtime: mtimeOf(p) }))
    .filter((f) => f.mtime > since && f.mtime <= activeGrace)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SYNC_LIMIT)
    .reverse();

  if (files.length === 0) {
    return { ok: true, sessionsSynced: 0, sessionsUpserted: 0, turnsUpserted: 0, reason: "nothing new to sync" };
  }

  const url = `${cfg.plouto.api_url.replace(/\/$/, "")}/api/ingest/sessions`;
  const email = gitEmailFallback();
  let sessionsSynced = 0;
  let turnsUpserted = 0;

  for (const f of files) {
    const extracted = extractSession(f.p);
    if (!extracted) {
      advanceSyncWatermark(new Date(f.mtime).toISOString());
      continue;
    }
    // a long session can exceed Plouto's 2 MB body cap on its own; the
    // server upserts by uuid, so re-sending the session row with each
    // turn chunk is safe
    for (const chunk of chunkTurns(extracted)) {
      const body = assembleIngestRequest([chunk], email);
      const result = await postIngest(url, cfg.plouto.token, body);
      if (!result.ok) {
        return {
          ok: false,
          sessionsSynced,
          sessionsUpserted: sessionsSynced,
          turnsUpserted,
          reason: result.reason,
        };
      }
      turnsUpserted += result.turnsUpserted;
    }
    sessionsSynced++;
    advanceSyncWatermark(new Date(f.mtime).toISOString());
  }

  log(`synced ${sessionsSynced} session(s), ${turnsUpserted} turns upserted`);
  return { ok: true, sessionsSynced, sessionsUpserted: sessionsSynced, turnsUpserted, reason: "" };
}

function* chunkTurns(extracted: ExtractedSession): Generator<ExtractedSession> {
  const { session, turns } = extracted;
  if (
    turns.length <= MAX_TURNS_PER_CHUNK &&
    JSON.stringify(turns).length < MAX_BATCH_BYTES
  ) {
    yield extracted;
    return;
  }
  for (let i = 0; i < turns.length; i += MAX_TURNS_PER_CHUNK) {
    yield { session, turns: turns.slice(i, i + MAX_TURNS_PER_CHUNK) };
  }
}

async function postIngest(
  url: string,
  token: string,
  body: IngestRequest,
): Promise<{ ok: boolean; sessionsUpserted: number; turnsUpserted: number; reason: string }> {
  log(`POST ${url}: ${body.sessions.length} session(s), ${body.turns.length} turn(s)`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      log(`ingest returned ${resp.status}`);
      return { ok: false, sessionsUpserted: 0, turnsUpserted: 0, reason: `server returned ${resp.status}` };
    }
    const json = (await resp.json()) as { sessions_upserted?: number; turns_upserted?: number };
    return {
      ok: true,
      sessionsUpserted: json.sessions_upserted ?? 0,
      turnsUpserted: json.turns_upserted ?? 0,
      reason: "",
    };
  } catch (e) {
    const msg = (e as Error).message;
    log(`sync failed: ${msg.includes("abort") ? `timeout after ${SYNC_TIMEOUT_MS}ms` : msg}`);
    return { ok: false, sessionsUpserted: 0, turnsUpserted: 0, reason: msg.slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------- connect ----------

export interface ConnectResult {
  ok: boolean;
  apiUrl: string;
  reason: string;
}

export function connectWithToken(token: string, apiUrl: string): ConnectResult {
  const p: PloutoConfig = {
    api_url: apiUrl.replace(/\/$/, ""),
    token,
    connected_at: new Date().toISOString(),
    last_synced_at: null,
  };
  setPloutoConnection(p);
  log(`connected to ${p.api_url} (manual token)`);
  return { ok: true, apiUrl: p.api_url, reason: "" };
}

export function disconnect(): boolean {
  const cfg = readConfig();
  if (!cfg.plouto) return false;
  setPloutoConnection(null);
  log("disconnected");
  return true;
}

// Browser flow, same shape as the legacy plugin's:
// open {api}/cli/login?port={port}&state={state}, the server logs the
// user in, mints a token, and redirects to our localhost callback.
export async function connectViaBrowser(apiUrl: string): Promise<ConnectResult> {
  const base = apiUrl.replace(/\/$/, "");
  const state = crypto.randomUUID();

  let resolveToken: (t: string | null) => void;
  const tokenPromise = new Promise<string | null>((resolve) => {
    resolveToken = resolve;
  });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      if (url.searchParams.get("state") !== state) {
        resolveToken(null);
        return new Response("state mismatch, try again", { status: 400 });
      }
      const token = url.searchParams.get("token");
      resolveToken(token);
      return new Response(
        "distill is connected. You can close this tab.",
        { headers: { "Content-Type": "text/plain" } },
      );
    },
  });

  const loginUrl = `${base}/cli/login?port=${server.port}&state=${state}`;
  console.log(`Opening browser: ${loginUrl}`);
  console.log("Waiting for sign-in...");
  openBrowser(loginUrl);

  const timeout = setTimeout(() => resolveToken!(null), CONNECT_TIMEOUT_MS);
  const token = await tokenPromise;
  clearTimeout(timeout);
  server.stop(true);

  if (!token) {
    return { ok: false, apiUrl: base, reason: "no token received (timeout or state mismatch)" };
  }
  return connectWithToken(token, base);
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.log(`Could not open a browser. Visit:\n  ${url}`);
  }
}
