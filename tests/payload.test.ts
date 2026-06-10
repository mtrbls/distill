import { describe, expect, test } from "bun:test";
import { scrubAttrs } from "../src/upskill/payload.ts";

describe("scrubAttrs (the solo privacy boundary)", () => {
  test("passes allowlisted count/duration/enum fields through", () => {
    const out = scrubAttrs({
      scanned: 4,
      pairs: 60,
      prompt_chars: 46_000,
      curator_latency_ms: 31_000,
      verdict_enum: "SKIP",
      error_type: "claude_exit_nonzero",
    });
    expect(out).toEqual({
      scanned: 4,
      pairs: 60,
      prompt_chars: 46_000,
      curator_latency_ms: 31_000,
      verdict_enum: "SKIP",
      error_type: "claude_exit_nonzero",
    });
  });

  test("drops content fields a future callsite might leak", () => {
    const out = scrubAttrs({
      scanned: 2,
      prompt: "the user's full prompt text",
      skill_body: "## When to use ...",
      skill_name: "verify-before-sweep",
      author: "alice@example.com",
      session_uuid: "67f28118",
      hostname: "alices-mbp",
    });
    expect(out).toEqual({ scanned: 2 });
  });

  test("drops everything when nothing is allowlisted", () => {
    expect(scrubAttrs({ secret: "x", email: "a@b.c" })).toEqual({});
  });

  test("the retired judge_latency_ms key is no longer allowlisted", () => {
    expect(scrubAttrs({ judge_latency_ms: 100 })).toEqual({});
  });

  test("root-span keys are allowlisted", () => {
    const out = scrubAttrs({
      "distill.scanned": 3,
      "distill.pairs": 12,
      "distill.verdict_enum": "CREATE",
      "distill.duration_ms": 32_000,
      "distill.user_email": "leak@example.com",
    });
    expect(out).toEqual({
      "distill.scanned": 3,
      "distill.pairs": 12,
      "distill.verdict_enum": "CREATE",
      "distill.duration_ms": 32_000,
    });
  });
});
