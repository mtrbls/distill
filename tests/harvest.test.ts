import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPairs, truncate } from "../src/upskill/harvest.ts";
import { DEFAULT_CONFIG } from "../src/upskill/types.ts";
import type { Candidate } from "../src/upskill/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "distill-harvest-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(name: string, lines: unknown[]): Candidate {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, sessionUuid: name, project: "test/proj", mtimeMs: Date.now() };
}

function userMsg(text: string): unknown {
  return { type: "user", message: { role: "user", content: text } };
}

function assistantMsg(text: string): unknown {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("extractPairs", () => {
  test("pairs user prompts with the following assistant reply", () => {
    const c = writeSession("s1", [
      userMsg("fix the bug"),
      assistantMsg("On it."),
      userMsg("now add a test"),
      assistantMsg("Test added."),
    ]);
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ user: "fix the bug", assistant: "On it." });
    expect(pairs[1]).toEqual({ user: "now add a test", assistant: "Test added." });
  });

  test("includes allowlisted tool inputs, never content blobs", () => {
    const c = writeSession("s2", [
      userMsg("run the linter"),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running it." },
            { type: "tool_use", name: "Bash", input: { command: "bun test --filter lint" } },
            { type: "tool_use", name: "Write", input: { file_path: "/tmp/a.ts", content: "WRITEBLOB" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/tmp/b.ts", old_string: "foo", new_string: "bar" } },
            { type: "tool_use", name: "mcp__github__create_pr", input: { title: "secretish" } },
          ],
        },
      },
    ]);
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    const a = pairs[0]!.assistant;
    expect(a).toContain("[Bash: bun test --filter lint]");
    expect(a).toContain('[Edit /tmp/b.ts: "foo" => "bar"]');
    expect(a).toContain("[Write /tmp/a.ts]");
    expect(a).not.toContain("WRITEBLOB");
    // unknown/MCP tools stay name-only
    expect(a).toContain("[tool: mcp__github__create_pr]");
    expect(a).not.toContain("secretish");
  });

  test("keeps the tail of error-bearing tool results, where the error lives", () => {
    const longOutput = "error: tests failed\n" + "x".repeat(2000) + "\nFINAL: expected 2 got 3";
    const c = writeSession("s2b", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: [{ type: "text", text: longOutput }] }],
        },
      },
      assistantMsg("Fixing the assertion."),
    ]);
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    expect(pairs[0]!.user).toContain("FINAL: expected 2 got 3");
    expect(pairs[0]!.user).toContain("...[snip]...");
  });

  test("prefers correction pairs over routine ones when the budget is tight", () => {
    const lines: unknown[] = [
      userMsg("no, that broke the build"),
      assistantMsg("Reverting the change."),
    ];
    for (let i = 0; i < 10; i++) {
      lines.push(userMsg(`routine question ${i} ` + "x".repeat(500)));
      lines.push(assistantMsg(`routine answer ${i} ` + "y".repeat(500)));
    }
    const c = writeSession("s2c", lines);
    const tight = { ...DEFAULT_CONFIG, maxPromptChars: 2_500 };
    const pairs = extractPairs({ candidates: [c], config: tight });
    // the correction is the OLDEST pair; pure recency would drop it
    expect(pairs.map((p) => p.user)).toContain("no, that broke the build");
    expect(pairs[pairs.length - 1]!.user).toContain("routine question 9");
  });

  test("excludes sidechain (subagent) traffic from the evidence", () => {
    const c = writeSession("side", [
      userMsg("real human question"),
      assistantMsg("real answer"),
      { ...userMsg("subagent task prompt") as object, isSidechain: true },
      { ...assistantMsg("subagent reply") as object, isSidechain: true },
    ]);
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.user).toBe("real human question");
  });

  test("skips non-message lines (snapshots, permission events, blank lines)", () => {
    const c = writeSession("s3", [
      { type: "permission-mode", permissionMode: "auto" },
      { type: "file-history-snapshot", snapshot: {} },
      userMsg("hello"),
      assistantMsg("hi"),
    ]);
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    expect(pairs).toHaveLength(1);
  });

  test("tolerates malformed JSON lines without crashing", () => {
    const path = join(dir, "bad.jsonl");
    writeFileSync(
      path,
      ["{not json", JSON.stringify(userMsg("q")), JSON.stringify(assistantMsg("a"))].join("\n"),
    );
    const c: Candidate = { path, sessionUuid: "bad", project: "p", mtimeMs: Date.now() };
    const pairs = extractPairs({ candidates: [c], config: DEFAULT_CONFIG });
    expect(pairs).toHaveLength(1);
  });

  test("returns empty for an unreadable file", () => {
    const c: Candidate = { path: join(dir, "ghost.jsonl"), sessionUuid: "g", project: "p", mtimeMs: 0 };
    expect(extractPairs({ candidates: [c], config: DEFAULT_CONFIG })).toEqual([]);
  });

  test("caps total content at maxPromptChars, keeping the most recent pairs", () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(userMsg(`question ${i} ` + "x".repeat(500)));
      lines.push(assistantMsg(`answer ${i} ` + "y".repeat(500)));
    }
    const c = writeSession("s4", lines);
    const tightConfig = { ...DEFAULT_CONFIG, maxPromptChars: 5_000 };
    const pairs = extractPairs({ candidates: [c], config: tightConfig });
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThan(50);
    // recency bias: the LAST question must survive the cap
    expect(pairs[pairs.length - 1]!.user).toContain("question 49");
  });
});

describe("truncate", () => {
  test("passes short strings through untouched", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  test("cuts long strings and marks the cut", () => {
    const out = truncate("a".repeat(200), 50);
    expect(out).toHaveLength(50 + " ...[truncated]".length);
    expect(out).toEndWith("...[truncated]");
  });
});
