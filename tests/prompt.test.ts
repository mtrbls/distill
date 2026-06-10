import { describe, expect, test } from "bun:test";
import { buildPrompt } from "../src/upskill/prompt.ts";
import type { ExistingSkill } from "../src/skill.ts";

const PAIRS = [
  { user: "fix the webhook retry bug", assistant: "Looking at the retry logic now." },
  { user: "same bug again in the other service", assistant: "Same root cause, patching." },
];

function skill(name: string, body = "## When to use\nExample."): ExistingSkill {
  return { name, path: `/tmp/${name}/SKILL.md`, frontmatter: null, body };
}

describe("buildPrompt", () => {
  test("forbids UPDATE when there are no existing skills", () => {
    const p = buildPrompt({ project: "Plouto", existing: [], pairs: PAIRS, sessionUuids: ["a"] });
    expect(p).toContain("UPDATE is FORBIDDEN");
    expect(p).toContain("(no existing skills in this scope)");
  });

  test("constrains UPDATE to the exact existing skill names", () => {
    const p = buildPrompt({
      project: "Plouto",
      existing: [skill("retry-webhooks"), skill("verify-slugs")],
      pairs: PAIRS,
      sessionUuids: ["a"],
    });
    expect(p).toContain("EXACTLY one of: [retry-webhooks, verify-slugs]");
  });

  test("embeds existing skill bodies for the curator to compare against", () => {
    const p = buildPrompt({
      project: "Plouto",
      existing: [skill("retry-webhooks", "## Workflow\nAlways check the dead-letter queue.")],
      pairs: PAIRS,
      sessionUuids: ["a"],
    });
    expect(p).toContain("--- skill: retry-webhooks ---");
    expect(p).toContain("dead-letter queue");
  });

  test("caps each existing skill body at 1500 chars", () => {
    const long = "x".repeat(5000);
    const p = buildPrompt({
      project: "Plouto",
      existing: [skill("big", long)],
      pairs: PAIRS,
      sessionUuids: ["a"],
    });
    // body is sliced; the full 5000-char run must not appear
    expect(p).not.toContain(long);
    expect(p).toContain("x".repeat(1500));
  });

  test("includes the activity pairs and the project name", () => {
    const p = buildPrompt({ project: "my/proj", existing: [], pairs: PAIRS, sessionUuids: ["a", "b"] });
    expect(p).toContain('"my/proj"');
    expect(p).toContain("fix the webhook retry bug");
    expect(p).toContain("2 prompt/response pairs from 2 session(s)");
  });

  test("instructs the new verdict vocabulary, not the retired one", () => {
    const p = buildPrompt({ project: "Plouto", existing: [], pairs: PAIRS, sessionUuids: ["a"] });
    expect(p).toContain('"verdict": "CREATE" | "UPDATE" | "SKIP"');
    expect(p).toContain("Default to SKIP");
    expect(p).not.toContain("KEEP");
    expect(p).not.toContain("MERGE");
  });

  test("truncates oversized pair content", () => {
    const huge = "y".repeat(3000);
    const p = buildPrompt({
      project: "Plouto",
      existing: [],
      pairs: [{ user: huge, assistant: huge }],
      sessionUuids: ["a"],
    });
    expect(p).toContain("...[truncated]");
    expect(p).not.toContain(huge);
  });
});
