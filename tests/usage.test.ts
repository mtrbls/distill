import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSession,
  extractSkillInvocations,
  listSessionFiles,
  summarizeUsage,
} from "../src/upskill/usage.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "distill-usage-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

// shapes copied from a real ~/.claude/projects JSONL
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "hello" },
    uuid: "u-1",
    timestamp: "2026-06-09T10:00:00.000Z",
    permissionMode: "auto",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/alice/proj",
    sessionId: "sess-1",
    version: "2.1.169",
    gitBranch: "main",
    ...over,
  };
}

function assistantLine(over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return envelope({
    type: "assistant",
    uuid: "a-1",
    requestId: "req-1",
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 700 },
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        service_tier: "standard",
        ...usage,
      },
    },
    ...over,
  });
}

describe("extractSession", () => {
  test("fills the session envelope from the first cwd-bearing line", () => {
    const p = writeJsonl("sess-1", [
      { type: "permission-mode", permissionMode: "auto" },
      envelope(),
      assistantLine(),
    ]);
    const e = extractSession(p)!;
    expect(e.session.id).toBe("sess-1");
    expect(e.session.cwd).toBe("/Users/alice/proj");
    expect(e.session.git_branch).toBe("main");
    expect(e.session.cli_version).toBe("2.1.169");
    expect(e.session.entrypoint).toBe("cli");
    expect(e.session.started_at).toBe("2026-06-09T10:00:00.000Z");
    expect(e.session.total_turns).toBe(2);
    expect(e.session.jsonl_path).toBe(p);
  });

  test("maps token usage including the 5m/1h cache split", () => {
    const p = writeJsonl("sess-1", [envelope(), assistantLine()]);
    const turn = extractSession(p)!.turns.find((t) => t.turn_type === "assistant")!;
    expect(turn.model_id).toBe("claude-opus-4-7");
    expect(turn.input_tokens).toBe(10);
    expect(turn.output_tokens).toBe(200);
    expect(turn.cache_read_tokens).toBe(5000);
    expect(turn.cache_creation_5m_tokens).toBe(100);
    expect(turn.cache_creation_1h_tokens).toBe(700);
    expect(turn.web_search_count).toBe(2);
    expect(turn.web_fetch_count).toBe(1);
    expect(turn.service_tier).toBe("standard");
    expect(turn.request_id).toBe("req-1");
    expect(turn.message_id).toBe("msg-1");
  });

  test("falls back to the bare cache_creation scalar as 5m (older format)", () => {
    const line = assistantLine();
    const msg = (line as any).message;
    delete msg.usage.cache_creation;
    msg.usage.cache_creation_input_tokens = 333;
    const p = writeJsonl("sess-1", [envelope(), line]);
    const turn = extractSession(p)!.turns.find((t) => t.turn_type === "assistant")!;
    expect(turn.cache_creation_5m_tokens).toBe(333);
    expect(turn.cache_creation_1h_tokens).toBe(0);
  });

  test("dedupes streamed duplicates of the same turn line, last wins", () => {
    const first = assistantLine();
    const second = assistantLine();
    ((second as any).message.usage as any).output_tokens = 999;
    const p = writeJsonl("sess-1", [envelope(), first, second]);
    const e = extractSession(p)!;
    const assistants = e.turns.filter((t) => t.turn_type === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.output_tokens).toBe(999);
  });

  test("keeps sidechain turns with the flag set", () => {
    const p = writeJsonl("sess-1", [
      envelope(),
      assistantLine({ uuid: "a-side", isSidechain: true }),
    ]);
    const turn = extractSession(p)!.turns.find((t) => t.uuid === "a-side")!;
    expect(turn.is_sidechain).toBe(true);
  });

  test("never copies tool inputs, only names", () => {
    const p = writeJsonl("sess-1", [
      envelope(),
      assistantLine({
        uuid: "a-2",
        message: {
          id: "msg-2",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo SECRET" } },
            { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/private" } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]);
    const e = extractSession(p)!;
    const turn = e.turns.find((t) => t.uuid === "a-2")!;
    expect(turn.tool_names).toEqual(["Bash", "Edit"]);
    expect(turn.tool_name).toBe("Bash");
    expect(turn.tool_count).toBe(2);
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(JSON.stringify(e)).not.toContain("/private");
  });

  test("user turns carry block counts but zero tokens", () => {
    const p = writeJsonl("sess-1", [
      envelope({
        message: {
          role: "user",
          content: [{ type: "text", text: "q" }, { type: "image", source: {} }],
        },
      }),
    ]);
    const turn = extractSession(p)!.turns[0]!;
    expect(turn.turn_type).toBe("user");
    expect(turn.input_tokens).toBe(0);
    expect(turn.has_image).toBe(true);
    expect(turn.block_counts).toEqual({ text: 1, image: 1 });
  });

  test("returns null for unreadable or message-free files", () => {
    expect(extractSession(join(dir, "ghost.jsonl"))).toBeNull();
    const p = writeJsonl("empty", [{ type: "file-history-snapshot", snapshot: {} }]);
    expect(extractSession(p)).toBeNull();
  });
});

describe("extractSkillInvocations", () => {
  test("reads skill names from Skill tool_use blocks, ignores args", () => {
    const p = writeJsonl("sess-1", [
      envelope(),
      assistantLine({
        uuid: "a-3",
        message: {
          id: "msg-3",
          role: "assistant",
          model: "claude-opus-4-7",
          content: [
            { type: "tool_use", id: "t1", name: "Skill", input: { skill: "grillme:grillme", args: "private topic" } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ]);
    expect(extractSkillInvocations(p)).toEqual(["grillme:grillme"]);
  });
});

describe("summarizeUsage", () => {
  test("aggregates by model, dedupes by message id, buckets mcp tools", () => {
    const p = writeJsonl("sess-1", [
      envelope(),
      assistantLine(),
      // second line of the same message: same message_id, different uuid
      assistantLine({ uuid: "a-1b" }),
      assistantLine({
        uuid: "a-2",
        message: {
          id: "msg-2",
          role: "assistant",
          model: "claude-fable-5",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
            { type: "tool_use", id: "t2", name: "mcp__github__create_pr", input: {} },
          ],
          usage: { input_tokens: 5, output_tokens: 50 },
        },
      }),
    ]);
    const s = summarizeUsage([p]);
    expect(s.sessions).toBe(1);
    expect(s.models["claude-opus-4-7"]!.outputTokens).toBe(200); // not 400
    expect(s.models["claude-opus-4-7"]!.messages).toBe(1);
    expect(s.models["claude-fable-5"]!.outputTokens).toBe(50);
    expect(s.tools).toEqual({ Bash: 1 });
    expect(s.mcpToolCalls).toBe(1);
  });

  test("skips synthetic model rows", () => {
    const p = writeJsonl("sess-1", [
      envelope(),
      assistantLine({
        uuid: "a-syn",
        message: {
          id: "msg-syn",
          role: "assistant",
          model: "<synthetic>",
          content: [],
          usage: { input_tokens: 9, output_tokens: 9 },
        },
      }),
    ]);
    const s = summarizeUsage([p]);
    expect(Object.keys(s.models)).toEqual([]);
  });
});

describe("listSessionFiles", () => {
  test("walks project dirs and filters by mtime", () => {
    const proj = join(dir, "-Users-alice-proj");
    mkdirSync(proj);
    writeFileSync(join(proj, "old.jsonl"), "{}\n");
    writeFileSync(join(proj, "new.jsonl"), "{}\n");
    const files = listSessionFiles(dir, 0);
    expect(files).toHaveLength(2);
    const future = listSessionFiles(dir, Date.now() + 60_000);
    expect(future).toHaveLength(0);
  });
});
