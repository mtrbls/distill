import { describe, expect, test } from "bun:test";
import { assembleIngestRequest } from "../src/upskill/plouto.ts";
import type { ExtractedSession } from "../src/upskill/usage.ts";

function extracted(sessionId: string, turnCount: number): ExtractedSession {
  return {
    session: {
      id: sessionId,
      workspace_id: "",
      cwd: "/Users/alice/proj",
      project_path_encoded: "-Users-alice-proj",
      git_branch: "main",
      cli_version: "2.1.169",
      user_type: "external",
      entrypoint: "cli",
      permission_mode: "auto",
      started_at: "2026-06-09T10:00:00.000Z",
      ended_at: "2026-06-09T11:00:00.000Z",
      total_turns: turnCount,
      is_subagent: 0,
      parent_session_id: null,
      jsonl_path: `/tmp/${sessionId}.jsonl`,
      jsonl_offset: 0,
    },
    turns: Array.from({ length: turnCount }, (_, i) => ({
      uuid: `${sessionId}-t${i}`,
      session_id: sessionId,
      workspace_id: "",
      parent_uuid: null,
      is_sidechain: false,
      turn_type: "assistant",
      timestamp: "2026-06-09T10:30:00.000Z",
      model_id: "claude-opus-4-7",
      stop_reason: "end_turn",
      input_tokens: 10,
      output_tokens: 100,
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
      request_id: null,
      message_id: `${sessionId}-m${i}`,
    })),
  };
}

describe("assembleIngestRequest", () => {
  test("builds the Plouto IngestRequest shape", () => {
    const req = assembleIngestRequest([extracted("s1", 2), extracted("s2", 1)], "alice@example.com");
    expect(req.provider_kind).toBe("claude_code");
    expect(req.sessions).toHaveLength(2);
    expect(req.turns).toHaveLength(3);
    expect(req.errors).toEqual([]);
    expect(req.agent_identity).toEqual({ email: "alice@example.com", display_name: "alice" });
  });

  test("every turn references its session", () => {
    const req = assembleIngestRequest([extracted("s1", 2)], "a@b.c");
    const sessionIds = new Set((req.sessions as any[]).map((s) => s.id));
    for (const t of req.turns as any[]) {
      expect(sessionIds.has(t.session_id)).toBe(true);
    }
  });

  test("omits agent identity when no email is available", () => {
    const req = assembleIngestRequest([extracted("s1", 1)], "");
    expect(req.agent_identity).toBeNull();
  });

  test("payload carries no content fields", () => {
    const json = JSON.stringify(assembleIngestRequest([extracted("s1", 2)], "a@b.c"));
    for (const banned of ['"prompt"', '"content"', '"input"', '"body"', '"text"']) {
      expect(json).not.toContain(banned);
    }
  });
});
