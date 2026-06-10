import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../src/upskill/verdict.ts";

const VALID = JSON.stringify({
  verdict: "CREATE",
  name: "verify-before-sweep",
  description: "Verify integration targets exist before bulk changes",
  trigger: "About to bulk-update third-party identifiers",
  body: "## When to use\nBefore sweeping changes.",
  reason: "Recurring pattern across two sessions",
});

describe("parseVerdict", () => {
  test("parses a clean CREATE verdict", () => {
    const v = parseVerdict(VALID);
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe("CREATE");
    expect(v!.name).toBe("verify-before-sweep");
    expect(v!.body).toContain("When to use");
  });

  test("parses UPDATE and SKIP verdict tokens", () => {
    expect(parseVerdict('{"verdict":"UPDATE","name":"x","body":"b"}')!.verdict).toBe("UPDATE");
    expect(parseVerdict('{"verdict":"SKIP","reason":"nothing new"}')!.verdict).toBe("SKIP");
  });

  test("tolerates markdown code fences around the JSON", () => {
    const fenced = "```json\n" + VALID + "\n```";
    expect(parseVerdict(fenced)!.verdict).toBe("CREATE");
  });

  test("tolerates leading prose before the JSON object", () => {
    const chatty = "Sure! Here is my verdict:\n\n" + VALID + "\n\nLet me know!";
    expect(parseVerdict(chatty)!.verdict).toBe("CREATE");
  });

  test("handles nested braces inside string values", () => {
    const nested = JSON.stringify({
      verdict: "SKIP",
      reason: "code like { foo: { bar: 1 } } appeared but is one-off",
    });
    const v = parseVerdict(nested);
    expect(v!.verdict).toBe("SKIP");
    expect(v!.reason).toContain("{ foo: { bar: 1 } }");
  });

  test("rejects the retired KEEP and MERGE tokens", () => {
    expect(parseVerdict('{"verdict":"KEEP","name":"x"}')).toBeNull();
    expect(parseVerdict('{"verdict":"MERGE","name":"x"}')).toBeNull();
  });

  test("rejects output with no JSON object", () => {
    expect(parseVerdict("I could not decide.")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  test("rejects unbalanced braces", () => {
    expect(parseVerdict('{"verdict":"CREATE","name":"x"')).toBeNull();
  });

  test("null-fills missing optional fields", () => {
    const v = parseVerdict('{"verdict":"SKIP"}');
    expect(v).not.toBeNull();
    expect(v!.name).toBeNull();
    expect(v!.description).toBeNull();
    expect(v!.trigger).toBeNull();
    expect(v!.body).toBeNull();
    expect(v!.reason).toBeNull();
  });

  test("coerces non-string fields to null instead of passing junk through", () => {
    const v = parseVerdict('{"verdict":"CREATE","name":42,"body":["a"]}');
    expect(v!.name).toBeNull();
    expect(v!.body).toBeNull();
  });
});
