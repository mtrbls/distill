// Parses whatever the curator emits on stdout into a Verdict, or
// null if there's no valid JSON in there.

import { createLogger } from "../log.ts";
import type { Verdict } from "./types.ts";

const log = createLogger("verdict");

export function parseVerdict(stdout: string): Verdict | null {
  // tolerate code fences and surrounding prose
  const cleaned = stdout
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  // first balanced { ... } object
  const start = cleaned.indexOf("{");
  if (start === -1) {
    log(`no JSON object found in ${stdout.length} chars`);
    return null;
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    log(`unbalanced braces, no closing match`);
    return null;
  }

  const blob = cleaned.slice(start, end + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    log(`JSON.parse failed: ${(e as Error).message}`);
    return null;
  }

  const v = parsed.verdict;
  if (v !== "CREATE" && v !== "UPDATE" && v !== "SKIP") {
    log(`invalid verdict field: ${JSON.stringify(v)}`);
    return null;
  }

  return {
    verdict: v,
    name: typeof parsed.name === "string" ? parsed.name : null,
    description: typeof parsed.description === "string" ? parsed.description : null,
    trigger: typeof parsed.trigger === "string" ? parsed.trigger : null,
    body: typeof parsed.body === "string" ? parsed.body : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
  };
}
