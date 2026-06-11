import { readFileSync } from "node:fs";
import { createLogger } from "../log.ts";
import type { Candidate, Pair, UpskillConfig } from "./types.ts";

const log = createLogger("harvest");

// Pairs whose user turn reads like a correction, or that carry
// error-bearing tool output, are the evidence distill exists to find
// ("a mistake you caught", "a check you skipped and regretted");
// they get the char budget before routine traffic does.
const CORRECTION_RE =
  /^(no[,. ]|nope\b|wrong\b|that's (not|wrong)|not what|still (fail|break|broken|wrong|not)|didn't work|doesn't work|undo\b|revert\b|you (broke|missed))/i;
const ERRORISH_RE =
  /\b(error|errors|failed|failure|exception|traceback|panic|enoent|exit code [1-9]|[1-9]\d* fail)\b/i;

export interface Harvest {
  pairs: Pair[];
  // every distinct cwd the transcripts recorded, collected during the
  // same read as the pairs (sessions can change cwd via /cd or
  // worktrees, so placement needs all of them, not the first)
  cwds: string[];
}

export function extractPairs(args: {
  candidates: Candidate[];
  config: UpskillConfig;
}): Harvest {
  const { candidates, config } = args;

  const all: Pair[] = [];
  const cwds = new Set<string>();
  for (const c of candidates) {
    const f =
      c.provider === "codex"
        ? extractCodexFromFile(c.path, config.maxMsgPerSession)
        : extractPairsFromFile(c.path, config.maxMsgPerSession);
    all.push(...f.pairs);
    for (const w of f.cwds) cwds.add(w);
  }

  if (all.length === 0) {
    log(`no pairs extracted from ${candidates.length} candidate(s)`);
    return { pairs: all, cwds: [...cwds] };
  }

  // budget selection: corrections and failures first, then recency;
  // re-sorted chronologically so the curator reads a coherent story
  const ranked = all
    .map((p, i) => ({ p, i, score: scorePair(p, all[i - 1]?.assistant) }))
    .sort((a, b) => b.score - a.score || b.i - a.i);
  let charCount = 0;
  const chosen: { p: Pair; i: number }[] = [];
  for (const r of ranked) {
    const size = r.p.user.length + r.p.assistant.length;
    if (charCount + size > config.maxPromptChars) continue;
    charCount += size;
    chosen.push(r);
  }
  chosen.sort((a, b) => a.i - b.i);
  log(`extracted ${all.length} pairs, kept ${chosen.length} (~${charCount} chars)`);
  return { pairs: chosen.map((r) => r.p), cwds: [...cwds] };
}

function scorePair(p: Pair, prevAssistant: string | undefined): number {
  let s = 0;
  if (CORRECTION_RE.test(p.user.trim())) s += 2;
  if (ERRORISH_RE.test(p.assistant)) s += 1;
  // a correction often follows the turn where things went wrong
  if (prevAssistant && ERRORISH_RE.test(prevAssistant)) s += 1;
  return s;
}

function extractPairsFromFile(
  jsonlPath: string,
  max: number,
): { pairs: Pair[]; cwds: Set<string> } {
  const cwds = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return { pairs: [], cwds };
  }
  const lines = raw.split("\n");
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && obj.cwd.startsWith("/")) cwds.add(obj.cwd);
    // sidechain = subagent traffic, the "user" there isn't the human
    if (obj.isSidechain === true) continue;
    if (obj.type === "user" || obj.type === "assistant") {
      const text = extractText(obj.message?.content);
      if (text) messages.push({ role: obj.type, text });
    }
  }
  const pairs: Pair[] = [];
  let pendingUser: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      pendingUser = m.text;
    } else if (m.role === "assistant" && pendingUser) {
      pairs.push({ user: pendingUser, assistant: m.text });
      pendingUser = null;
    }
  }
  return { pairs: pairs.slice(-max), cwds };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(renderToolUse(block));
    } else if (block.type === "tool_result") {
      const text = toolResultText(block.content);
      if (text) parts.push(`[tool_result] ${clipResult(text)}`);
    }
  }
  return parts.join("\n").trim();
}

// Per-tool input allowlist. This evidence goes only to the local
// `claude -p` curator — the same place the session content came from,
// never over the network — but inputs are still allowlisted
// field-by-field: blobs like Write content are budget-blowing noise,
// and the command/edit fields are where mistakes-caught actually live.
function renderToolUse(block: any): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input = block.input && typeof block.input === "object" ? block.input : {};
  switch (name) {
    case "Bash":
      if (typeof input.command === "string") {
        return `[Bash: ${truncate(input.command, 200)}]`;
      }
      break;
    case "Edit":
      if (typeof input.file_path === "string") {
        const oldS = typeof input.old_string === "string" ? truncate(input.old_string, 150) : "";
        const newS = typeof input.new_string === "string" ? truncate(input.new_string, 150) : "";
        return `[Edit ${input.file_path}: ${JSON.stringify(oldS)} => ${JSON.stringify(newS)}]`;
      }
      break;
    case "Write":
    case "Read":
    case "NotebookEdit":
      if (typeof input.file_path === "string") {
        return `[${name} ${input.file_path}]`;
      }
      break;
    case "Grep":
    case "Glob":
      if (typeof input.pattern === "string") {
        return `[${name}: ${truncate(input.pattern, 120)}]`;
      }
      break;
  }
  return `[tool: ${name}]`;
}

// ---------- Codex rollout parser ----------
// Lines are {type, payload}. Human/agent text lives in
// response_item/message (roles user|assistant|developer); tool
// traffic in function_call(+_output) / custom_tool_call(+_output);
// cwd in session_meta and per-turn turn_context. event_msg lines
// duplicate messages as UI events — ignored.

// Codex injects machine-generated user messages; they are not the
// human and would pollute pairing
const CODEX_BOILERPLATE = [
  "<environment_context>",
  "<turn_context>",
  "<user_instructions>",
  "<turn_aborted",
  "<permissions",
];

function extractCodexFromFile(
  jsonlPath: string,
  max: number,
): { pairs: Pair[]; cwds: Set<string> } {
  const cwds = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return { pairs: [], cwds };
  }
  const messages: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj?.payload;
    if (!p || typeof p !== "object") continue;
    if (obj.type === "session_meta" || obj.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd.startsWith("/")) cwds.add(p.cwd);
      continue;
    }
    if (obj.type !== "response_item") continue;
    switch (p.type) {
      case "message": {
        if (p.role !== "user" && p.role !== "assistant") break;
        const text = (Array.isArray(p.content) ? p.content : [])
          .filter(
            (b: any) =>
              b &&
              (b.type === "input_text" || b.type === "output_text") &&
              typeof b.text === "string",
          )
          .map((b: any) => b.text)
          .join("\n")
          .trim();
        if (!text) break;
        if (p.role === "user" && CODEX_BOILERPLATE.some((m) => text.startsWith(m))) break;
        messages.push({ role: p.role, text });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        messages.push({ role: "assistant", text: renderCodexCall(p) });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const out = typeof p.output === "string" ? p.output : "";
        if (out) messages.push({ role: "user", text: `[tool_result] ${clipResult(out)}` });
        break;
      }
    }
  }
  const pairs: Pair[] = [];
  let pendingUser: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      pendingUser = m.text;
    } else if (m.role === "assistant" && pendingUser) {
      pairs.push({ user: pendingUser, assistant: m.text });
      pendingUser = null;
    }
  }
  return { pairs: pairs.slice(-max), cwds };
}

function renderCodexCall(p: any): string {
  const name = typeof p.name === "string" ? p.name : "tool";
  try {
    const args = JSON.parse(p.arguments ?? "{}");
    if (name === "exec_command" && typeof args.cmd === "string") {
      return `[exec: ${truncate(args.cmd, 200)}]`;
    }
    if (typeof args.path === "string" || typeof args.file_path === "string") {
      return `[${name} ${args.path ?? args.file_path}]`;
    }
  } catch {
    // unparseable arguments: name-only
  }
  return `[tool: ${name}]`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

// errors are the signal and usually live at the tail of the output;
// successes get a short head-only cap
function clipResult(s: string): string {
  const t = s.trim();
  if (ERRORISH_RE.test(t)) return clipMiddle(t, 300, 500);
  return truncate(t, 400);
}

function clipMiddle(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 24) return s;
  return s.slice(0, head) + " ...[snip]... " + s.slice(-tail);
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + " ...[truncated]";
}
