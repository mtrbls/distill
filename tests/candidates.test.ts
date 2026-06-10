import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExistingSkills, writeNewSkill } from "../src/skill.ts";
import { applyVerdict } from "../src/upskill/apply.ts";
import { expireCandidates } from "../src/upskill/candidates.ts";
import type { Candidate, Verdict } from "../src/upskill/types.ts";

let skillsRoot: string;
let candidatesRoot: string;

const SESSION: Candidate[] = [
  { path: "/tmp/s.jsonl", dir: "-Users-alice-proj", sessionUuid: "s", project: "proj", mtimeMs: 1 },
];

function verdict(over: Partial<Verdict>): Verdict {
  return {
    verdict: "CREATE",
    name: "watch-the-dlq",
    description: "Check the dead-letter queue after webhook changes",
    trigger: "After modifying webhook handlers",
    body: "## When to use\nAfter webhook changes.",
    reason: "one clear occurrence",
    ...over,
  };
}

beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "distill-skills-"));
  candidatesRoot = mkdtempSync(join(tmpdir(), "distill-cands-"));
});

afterEach(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
  rmSync(candidatesRoot, { recursive: true, force: true });
  rmSync(candidatesRoot + "-archive", { recursive: true, force: true });
});

describe("CREATE routes to the candidate tier", () => {
  test("writes a dormant candidate, not an active skill", () => {
    const r = applyVerdict({
      verdict: verdict({}),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "alice@example.com",
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("candidate");
    expect(existsSync(join(candidatesRoot, "watch-the-dlq", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, "watch-the-dlq"))).toBe(false);
  });

  test("probe CREATE goes live directly", () => {
    const r = applyVerdict({
      verdict: verdict({}),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "alice@example.com",
      probe: true,
    });
    expect(r.tier).toBe("active");
    expect(existsSync(join(skillsRoot, "watch-the-dlq", "SKILL.md"))).toBe(true);
    expect(existsSync(join(candidatesRoot, "watch-the-dlq"))).toBe(false);
  });

  test("re-CREATE of an existing candidate folds in as a re-observation", () => {
    applyVerdict({ verdict: verdict({}), candidates: SESSION, skillsRoot, candidatesRoot, author: "a@b.c" });
    const r = applyVerdict({
      verdict: verdict({ body: "## When to use\nSecond sighting." }),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("candidate");
    const c = listExistingSkills(candidatesRoot)[0]!;
    expect(c.frontmatter!.version).toBe(2);
    expect(c.body).toContain("Second sighting");
  });
});

describe("PROMOTE", () => {
  test("moves a candidate into the live root and removes the candidate", () => {
    applyVerdict({ verdict: verdict({}), candidates: SESSION, skillsRoot, candidatesRoot, author: "a@b.c" });
    const r = applyVerdict({
      verdict: verdict({ verdict: "PROMOTE", body: "## When to use\nMerged evidence." }),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("active");
    const live = listExistingSkills(skillsRoot);
    expect(live).toHaveLength(1);
    expect(live[0]!.body).toContain("Merged evidence");
    expect(existsSync(join(candidatesRoot, "watch-the-dlq"))).toBe(false);
  });

  test("merges source_projects from the candidate and the new evidence", () => {
    applyVerdict({
      verdict: verdict({}),
      candidates: [{ ...SESSION[0]!, dir: "-Users-alice-other" }],
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    applyVerdict({
      verdict: verdict({ verdict: "PROMOTE" }),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    const fm = listExistingSkills(skillsRoot)[0]!.frontmatter!;
    expect(fm.source_projects).toContain("-Users-alice-other");
    expect(fm.source_projects).toContain("-Users-alice-proj");
  });

  test("falls back to the candidate's description when the verdict omits it", () => {
    applyVerdict({ verdict: verdict({}), candidates: SESSION, skillsRoot, candidatesRoot, author: "a@b.c" });
    const r = applyVerdict({
      verdict: verdict({ verdict: "PROMOTE", description: null }),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    expect(r.ok).toBe(true);
    expect(listExistingSkills(skillsRoot)[0]!.frontmatter!.description).toContain("dead-letter");
  });

  test("fails gracefully when the named candidate does not exist", () => {
    const r = applyVerdict({
      verdict: verdict({ verdict: "PROMOTE", name: "ghost" }),
      candidates: SESSION,
      skillsRoot,
      candidatesRoot,
      author: "a@b.c",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not a candidate");
    expect(listExistingSkills(skillsRoot)).toHaveLength(0);
  });
});

describe("expireCandidates", () => {
  test("archives candidates older than the cutoff, keeps fresh ones", () => {
    writeNewSkill({ skillsRoot: candidatesRoot, name: "stale", description: "d", body: "b", author: "a@b.c" });
    writeNewSkill({ skillsRoot: candidatesRoot, name: "fresh", description: "d", body: "b", author: "a@b.c" });
    const future = Date.now() + 46 * 24 * 60 * 60 * 1000;

    // both were just written; from "now" neither is stale
    expect(expireCandidates({ root: candidatesRoot, maxAgeDays: 45 })).toEqual([]);
    // 46 days later both are stale
    const expired = expireCandidates({ root: candidatesRoot, maxAgeDays: 45, nowMs: future });
    expect(expired.sort()).toEqual(["fresh", "stale"]);
    expect(listExistingSkills(candidatesRoot)).toHaveLength(0);
    expect(existsSync(join(candidatesRoot + "-archive", "stale", "SKILL.md"))).toBe(true);
  });

  test("returns empty for a missing root", () => {
    expect(expireCandidates({ root: join(candidatesRoot, "nope"), maxAgeDays: 45 })).toEqual([]);
  });
});
