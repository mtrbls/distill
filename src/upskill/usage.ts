// Usage metadata extractor. TypeScript port of Plouto's
// server-side extractor — same whitelist discipline: build new
// objects with only the fields we've decided are safe, never copy.
// Tool names yes, tool inputs never. Counts and enums, never content.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../log.ts";

const log = createLogger("usage");

const TURN_LINE_TYPES = new Set(["user", "assistant", "tool_result"]);

export interface SessionPayload {
  id: string;
  workspace_id: string;
  cwd: string;
  project_path_encoded: string;
  git_branch: string | null;
  cli_version: string | null;
  user_type: string | null;
  entrypoint: string | null;
  permission_mode: string | null;
  started_at: string;
  ended_at: string | null;
  total_turns: number;
  is_subagent: number;
  parent_session_id: string | null;
  jsonl_path: string;
  jsonl_offset: number;
}

export interface TurnPayload {
  uuid: string;
  session_id: string;
  workspace_id: string;
  parent_uuid: string | null;
  is_sidechain: boolean;
  turn_type: string;
  timestamp: string;
  model_id: string | null;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  web_search_count: number;
  web_fetch_count: number;
  tool_name: string | null;
  tool_names: string[];
  tool_count: number;
  block_counts: Record<string, number>;
  has_thinking: boolean;
  has_image: boolean;
  speed: string | null;
  service_tier: string | null;
  request_id: string | null;
  message_id: string | null;
}

export interface ExtractedSession {
  session: SessionPayload;
  turns: TurnPayload[];
}

export function extractSession(jsonlPath: string): ExtractedSession | null {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return null;
  }

  const fallbackId = basename(jsonlPath).replace(/\.jsonl$/, "");
  let session: SessionPayload | null = null;
  // streaming rewrites the same turn line; last occurrence per uuid wins
  const turnsByUuid = new Map<string, TurnPayload>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    const ts = safeStr(obj.timestamp);
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (!session && safeStr(obj.cwd)) {
      session = {
        id: safeStr(obj.sessionId) ?? fallbackId,
        workspace_id: "",
        cwd: safeStr(obj.cwd) ?? "",
        project_path_encoded: basename(join(jsonlPath, "..")),
        git_branch: safeStr(obj.gitBranch),
        cli_version: safeStr(obj.version),
        user_type: safeStr(obj.userType),
        entrypoint: safeStr(obj.entrypoint),
        permission_mode: safeStr(obj.permissionMode),
        started_at: ts ?? new Date(0).toISOString(),
        ended_at: null,
        total_turns: 0,
        is_subagent: 0,
        parent_session_id: null,
        jsonl_path: jsonlPath,
        jsonl_offset: 0,
      };
    }

    const turn = extractTurn(obj, fallbackId);
    if (turn) turnsByUuid.set(turn.uuid, turn);
  }

  if (!session) {
    // a file with no envelope lines (snapshots only) has nothing to sync
    if (turnsByUuid.size === 0) return null;
    session = {
      id: fallbackId,
      workspace_id: "",
      cwd: "",
      project_path_encoded: basename(join(jsonlPath, "..")),
      git_branch: null,
      cli_version: null,
      user_type: null,
      entrypoint: null,
      permission_mode: null,
      started_at: firstTs ?? new Date(0).toISOString(),
      ended_at: null,
      total_turns: 0,
      is_subagent: 0,
      parent_session_id: null,
      jsonl_path: jsonlPath,
      jsonl_offset: 0,
    };
  }

  const turns = [...turnsByUuid.values()];
  session.started_at = firstTs ?? session.started_at;
  session.ended_at = lastTs;
  session.total_turns = turns.length;
  return { session, turns };
}

function extractTurn(line: any, fallbackSessionId: string): TurnPayload | null {
  const lineType = line.type;
  if (!TURN_LINE_TYPES.has(lineType)) return null;

  const uuid = safeStr(line.uuid);
  const sessionId = safeStr(line.sessionId) ?? fallbackSessionId;
  const timestamp = safeStr(line.timestamp);
  if (!uuid || !sessionId || !timestamp) return null;

  const out: TurnPayload = {
    uuid,
    session_id: sessionId,
    workspace_id: "",
    parent_uuid: safeStr(line.parentUuid),
    is_sidechain: !!line.isSidechain,
    turn_type: lineType,
    timestamp,
    model_id: null,
    stop_reason: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    web_search_count: 0,
    web_fetch_count: 0,
    tool_name: null,
    tool_names: [],
    tool_count: 0,
    block_counts: {},
    has_thinking: false,
    has_image: false,
    speed: null,
    service_tier: null,
    request_id: safeStr(line.requestId),
    message_id: null,
  };

  const message = line.message;
  if (!message || typeof message !== "object") return out;

  const content = message.content;
  out.block_counts = countBlocks(content);
  out.has_image = hasBlockType(content, "image");
  out.message_id = safeStr(message.id);

  if (lineType !== "assistant") return out;

  out.model_id = safeStr(message.model);
  out.stop_reason = safeStr(message.stop_reason);
  out.tool_names = toolUseNames(content);
  out.tool_name = out.tool_names[0] ?? null;
  out.tool_count = out.tool_names.length;
  out.has_thinking = hasBlockType(content, "thinking");

  const usage = message.usage;
  if (usage && typeof usage === "object") {
    out.input_tokens = safeInt(usage.input_tokens);
    out.output_tokens = safeInt(usage.output_tokens);
    out.cache_read_tokens = safeInt(usage.cache_read_input_tokens);
    out.speed = safeStr(usage.speed);
    out.service_tier = safeStr(usage.service_tier);

    const cc = usage.cache_creation;
    if (cc && typeof cc === "object") {
      out.cache_creation_5m_tokens = safeInt(cc.ephemeral_5m_input_tokens);
      out.cache_creation_1h_tokens = safeInt(cc.ephemeral_1h_input_tokens);
    } else {
      // older format only had the bare scalar; the 5m/1h split didn't
      // exist yet, treat it all as 5m like Plouto's extractor does
      out.cache_creation_5m_tokens = safeInt(usage.cache_creation_input_tokens);
    }

    const stu = usage.server_tool_use;
    if (stu && typeof stu === "object") {
      out.web_search_count = safeInt(stu.web_search_requests);
      out.web_fetch_count = safeInt(stu.web_fetch_requests);
    }
  }

  return out;
}

// ---------- skill invocations (local display only, not synced) ----------

export function extractSkillInvocations(jsonlPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }
  const skills: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"name":"Skill"')) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use" && block.name === "Skill") {
        const s = safeStr(block.input?.skill);
        if (s) skills.push(s);
      }
    }
  }
  return skills;
}

// ---------- local summary for `distill usage` ----------

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messages: number;
}

export interface UsageSummary {
  sessions: number;
  from: string | null;
  to: string | null;
  models: Record<string, ModelUsage>;
  tools: Record<string, number>;
  mcpToolCalls: number;
  skillsInvoked: Record<string, number>;
}

export function listSessionFiles(sessionsRoot: string, sinceMs: number): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(sessionsRoot);
  } catch {
    return out;
  }
  for (const dir of projects) {
    const full = join(sessionsRoot, dir);
    let entries: string[];
    try {
      if (!statSync(full).isDirectory()) continue;
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      try {
        if (statSync(p).mtimeMs >= sinceMs) out.push(p);
      } catch {
        // file vanished mid-walk
      }
    }
  }
  return out;
}

export function summarizeUsage(paths: string[]): UsageSummary {
  const summary: UsageSummary = {
    sessions: 0,
    from: null,
    to: null,
    models: {},
    tools: {},
    mcpToolCalls: 0,
    skillsInvoked: {},
  };

  for (const path of paths) {
    const extracted = extractSession(path);
    if (!extracted) continue;
    summary.sessions++;

    const { session, turns } = extracted;
    if (!summary.from || session.started_at < summary.from) summary.from = session.started_at;
    if (session.ended_at && (!summary.to || session.ended_at > summary.to)) {
      summary.to = session.ended_at;
    }

    // a message's usage repeats across its streamed turn lines; count
    // each message once
    const seenMessages = new Set<string>();
    for (const t of turns) {
      for (const name of t.tool_names) {
        if (name.startsWith("mcp__")) {
          summary.mcpToolCalls++;
        } else {
          summary.tools[name] = (summary.tools[name] ?? 0) + 1;
        }
      }
      if (t.turn_type !== "assistant" || !t.model_id) continue;
      if (t.model_id === "<synthetic>") continue;
      const dedupeKey = t.message_id ?? t.uuid;
      if (seenMessages.has(dedupeKey)) continue;
      seenMessages.add(dedupeKey);

      const m = (summary.models[t.model_id] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messages: 0,
      });
      m.inputTokens += t.input_tokens;
      m.outputTokens += t.output_tokens;
      m.cacheReadTokens += t.cache_read_tokens;
      m.cacheCreationTokens += t.cache_creation_5m_tokens + t.cache_creation_1h_tokens;
      m.messages++;
    }

    for (const s of extractSkillInvocations(path)) {
      summary.skillsInvoked[s] = (summary.skillsInvoked[s] ?? 0) + 1;
    }
  }

  log(`summarized ${summary.sessions} session(s) from ${paths.length} file(s)`);
  return summary;
}

// ---------- helpers ----------

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function safeInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function countBlocks(content: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(content)) return counts;
  for (const block of content) {
    const t = block?.type;
    if (typeof t === "string") counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

function hasBlockType(content: unknown, type: string): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === type);
}

function toolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      names.push(block.name);
    }
  }
  return names;
}
