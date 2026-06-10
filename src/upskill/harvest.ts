import { readFileSync } from "node:fs";
import { createLogger } from "../log.ts";
import type { Candidate, Pair, UpskillConfig } from "./types.ts";

const log = createLogger("harvest");

export function extractPairs(args: {
  candidates: Candidate[];
  config: UpskillConfig;
}): Pair[] {
  const { candidates, config } = args;

  const all: Pair[] = [];
  for (const c of candidates) {
    all.push(...extractPairsFromFile(c.path, config.maxMsgPerSession));
  }

  if (all.length === 0) {
    log(`no pairs extracted from ${candidates.length} candidate(s)`);
    return all;
  }

  // Char-budget cap, keeping the most recent pairs to fit the curator's
  // prompt limit.
  let charCount = 0;
  const capped: Pair[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i]!;
    const size = p.user.length + p.assistant.length;
    if (charCount + size > config.maxPromptChars) break;
    charCount += size;
    capped.unshift(p);
  }
  log(`extracted ${all.length} pairs, capped to ${capped.length} (~${charCount} chars)`);
  return capped;
}

function extractPairsFromFile(jsonlPath: string, max: number): Pair[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
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
  return pairs.slice(-max);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        // signal that a tool was used without dumping its full input
        parts.push(`[tool: ${block.name}]`);
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        parts.push(`[tool_result] ${block.content.slice(0, 400)}`);
      }
    }
  }
  return parts.join("\n").trim();
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + " ...[truncated]";
}
