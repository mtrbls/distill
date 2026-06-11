import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCandidates, newestCodexSession } from "../src/upskill/discover.ts";
import { extractPairs } from "../src/upskill/harvest.ts";
import { DEFAULT_CONFIG } from "../src/upskill/types.ts";
import type { Candidate } from "../src/upskill/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "distill-codex-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// fixtures mirror the real rollout schema observed in
// ~/.codex/sessions (session_meta / turn_context / response_item)
function meta(cwd: string): unknown {
  return {
    type: "session_meta",
    payload: { id: "s1", timestamp: "2026-06-11T08:00:00Z", cwd, cli_version: "0.115.0" },
  };
}
function userMsg(text: string): unknown {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
function agentMsg(text: string): unknown {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

function writeRollout(rel: string, lines: unknown[]): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function codexCandidate(path: string): Candidate {
  return { path, sessionUuid: "s1", project: "proj", mtimeMs: Date.now(), provider: "codex" };
}

describe("codex harvest", () => {
  test("pairs user prompts with assistant replies; collects cwds from meta and turn_context", () => {
    const p = writeRollout("2026/06/11/rollout-a.jsonl", [
      meta("/Users/alice/proj"),
      { type: "turn_context", payload: { turn_id: "t1", cwd: "/Users/alice/other" } },
      userMsg("fix the flaky test"),
      agentMsg("Found the race in setup; fixing."),
    ]);
    const { pairs, cwds } = extractPairs({ candidates: [codexCandidate(p)], config: DEFAULT_CONFIG });
    expect(pairs).toEqual([{ user: "fix the flaky test", assistant: "Found the race in setup; fixing." }]);
    expect(cwds.sort()).toEqual(["/Users/alice/other", "/Users/alice/proj"]);
  });

  test("skips machine-generated user boilerplate and developer messages", () => {
    const p = writeRollout("2026/06/11/rollout-b.jsonl", [
      meta("/Users/alice/proj"),
      userMsg("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
      {
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "sys stuff" }] },
      },
      userMsg("real question"),
      agentMsg("real answer"),
    ]);
    const { pairs } = extractPairs({ candidates: [codexCandidate(p)], config: DEFAULT_CONFIG });
    expect(pairs).toEqual([{ user: "real question", assistant: "real answer" }]);
  });

  test("renders exec commands and clips tool output, errors keep their tail", () => {
    const longErr = "error: build failed\n" + "x".repeat(2000) + "\nFINAL: missing semicolon";
    const p = writeRollout("2026/06/11/rollout-c.jsonl", [
      meta("/Users/alice/proj"),
      userMsg("run the build"),
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "npm run build", workdir: "/x" }),
          call_id: "c1",
        },
      },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: longErr } },
      agentMsg("The build fails on a missing semicolon."),
    ]);
    const { pairs } = extractPairs({ candidates: [codexCandidate(p)], config: DEFAULT_CONFIG });
    const all = pairs.map((x) => x.user + "\n" + x.assistant).join("\n");
    expect(all).toContain("[exec: npm run build]");
    expect(all).toContain("FINAL: missing semicolon");
    expect(all).toContain("...[snip]...");
  });

  test("ignores event_msg duplicates", () => {
    const p = writeRollout("2026/06/11/rollout-d.jsonl", [
      meta("/Users/alice/proj"),
      { type: "event_msg", payload: { type: "user_message", message: "dup" } },
      { type: "event_msg", payload: { type: "agent_message", message: "dup" } },
      userMsg("q"),
      agentMsg("a"),
    ]);
    const { pairs } = extractPairs({ candidates: [codexCandidate(p)], config: DEFAULT_CONFIG });
    expect(pairs).toHaveLength(1);
  });
});

describe("codex usage extraction (sync payload)", () => {
  test("builds session + turns with tokens, model, and deterministic uuids", async () => {
    const { extractCodexSession } = await import("../src/upskill/usage.ts");
    const lines = [
      {
        type: "session_meta",
        timestamp: "2026-06-11T08:00:00.000Z",
        payload: {
          id: "sess-1",
          cwd: "/Users/alice/proj",
          cli_version: "0.115.0",
          originator: "codex-tui",
          git: { branch: "main", commit_hash: "abc" },
        },
      },
      {
        type: "turn_context",
        timestamp: "2026-06-11T08:00:01.000Z",
        payload: { turn_id: "t1", cwd: "/Users/alice/proj", model: "gpt-5.4" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-11T08:00:02.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-06-11T08:00:03.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
          call_id: "c1",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-06-11T08:00:04.000Z",
        payload: { type: "function_call_output", call_id: "c1", output: "ok" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-11T08:00:05.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      },
      {
        type: "event_msg",
        timestamp: "2026-06-11T08:00:06.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 60,
              output_tokens: 20,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ];
    const p = writeRollout("2026/06/11/rollout-usage.jsonl", lines);
    const e = extractCodexSession(p)!;
    expect(e.session.id).toBe("sess-1");
    expect(e.session.git_branch).toBe("main");
    expect(e.session.started_at).toBe("2026-06-11T08:00:00.000Z");
    expect(e.session.ended_at).toBe("2026-06-11T08:00:06.000Z");
    expect(e.turns.map((t) => t.turn_type)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    expect(e.turns[1]!.tool_names).toEqual(["exec_command"]);
    // usage attaches to the most recent assistant turn
    const last = e.turns[3]!;
    expect(last.model_id).toBe("gpt-5.4");
    expect(last.input_tokens).toBe(100);
    expect(last.cache_read_tokens).toBe(60);
    expect(last.output_tokens).toBe(25); // output + reasoning
    // deterministic uuids: re-extracting yields identical ids
    expect(extractCodexSession(p)!.turns.map((t) => t.uuid)).toEqual(e.turns.map((t) => t.uuid));
    // never any content fields
    const json = JSON.stringify(e);
    expect(json).not.toContain('"q"');
    expect(json).not.toContain("output_text");
  });

  test("assembleIngestRequest tags codex payloads", async () => {
    const { assembleIngestRequest } = await import("../src/upskill/plouto.ts");
    const req = assembleIngestRequest([], "a@b.c", "codex");
    expect(req.provider_kind).toBe("codex");
    expect(assembleIngestRequest([], "a@b.c").provider_kind).toBe("claude_code");
  });
});

describe("codex discovery", () => {
  const WATERMARK = { version: 1, lastDate: null, lastSessionUuid: null };

  test("walks the date-sharded tree and groups by the session's own cwd", () => {
    const p = writeRollout("2026/06/11/rollout-e.jsonl", [meta("/Users/alice/proj"), userMsg("q")]);
    const found = findCandidates({
      sessionsRoot: join(dir, "no-claude"),
      codexSessionsRoot: dir,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: true,
      triggerPath: p, // fresh file: exempt from grace like any trigger
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.provider).toBe("codex");
    expect(found[0]!.dir).toBe("codex:/Users/alice/proj");
  });

  test("newestCodexSession picks the most recent rollout", () => {
    writeRollout("2026/06/10/rollout-old.jsonl", [meta("/a")]);
    const newer = writeRollout("2026/06/11/rollout-new.jsonl", [meta("/b")]);
    expect(newestCodexSession(dir)).toBe(newer);
  });
});
