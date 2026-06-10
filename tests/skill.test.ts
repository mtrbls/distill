import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExistingSkills, mergeSkill, writeNewSkill } from "../src/skill.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "distill-skill-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeNewSkill", () => {
  test("writes a SKILL.md that round-trips through listExistingSkills", () => {
    const { path, version } = writeNewSkill({
      skillsRoot: root,
      name: "verify-before-sweep",
      description: "Verify targets exist before bulk changes",
      trigger: "About to bulk-update identifiers",
      body: "## When to use\nBefore sweeps.",
      author: "alice@example.com",
    });
    expect(version).toBe(1);
    expect(path).toBe(join(root, "verify-before-sweep", "SKILL.md"));

    const skills = listExistingSkills(root);
    expect(skills).toHaveLength(1);
    const fm = skills[0]!.frontmatter!;
    expect(fm.name).toBe("verify-before-sweep");
    expect(fm.description).toBe("Verify targets exist before bulk changes");
    expect(fm.author).toBe("alice@example.com");
    expect(fm.contributors).toEqual([]);
    expect(fm.version).toBe(1);
    expect(fm.created_by).toBe("distill");
    expect(skills[0]!.body).toContain("Before sweeps.");
  });

  test("refuses to overwrite an existing skill", () => {
    const input = {
      skillsRoot: root,
      name: "dupe",
      description: "d",
      body: "b",
      author: "a@b.c",
    };
    writeNewSkill(input);
    expect(() => writeNewSkill(input)).toThrow(/already exists/);
  });

  test("rejects invalid skill names", () => {
    for (const bad of ["Has Spaces", "UPPER", "-leading-dash", "a".repeat(64), ""]) {
      expect(() =>
        writeNewSkill({
          skillsRoot: root,
          name: bad,
          description: "d",
          body: "b",
              author: "a@b.c",
        }),
      ).toThrow(/invalid skill name/);
    }
  });

  test("collapses multiline description and trigger to one line", () => {
    writeNewSkill({
      skillsRoot: root,
      name: "multiline",
      description: "First line\nsecond line\n  third line  ",
      trigger: "When this\nhappens",
      body: "b",
      author: "a@b.c",
    });
    const fm = listExistingSkills(root)[0]!.frontmatter!;
    expect(fm.description).toBe("First line second line third line");
    expect(fm.trigger).toBe("When this happens");
  });

  test("quotes a description starting with a YAML indicator char", () => {
    writeNewSkill({
      skillsRoot: root,
      name: "yaml-indicator",
      description: "[draft] verify targets first",
      body: "b",
      author: "a@b.c",
    });
    const raw = readFileSync(join(root, "yaml-indicator", "SKILL.md"), "utf-8");
    expect(raw).toContain('description: "[draft] verify targets first"');
    const fm = listExistingSkills(root)[0]!.frontmatter!;
    expect(fm.description).toBe("[draft] verify targets first");
  });

  test("quotes description containing a colon so frontmatter survives", () => {
    writeNewSkill({
      skillsRoot: root,
      name: "colon-desc",
      description: "Rule: always verify first",
      body: "b",
      author: "a@b.c",
    });
    const fm = listExistingSkills(root)[0]!.frontmatter!;
    expect(fm.description).toBe("Rule: always verify first");
  });
});

describe("mergeSkill", () => {
  function seed(): void {
    writeNewSkill({
      skillsRoot: root,
      name: "retry-webhooks",
      description: "Retry failed webhooks",
      body: "v1 body",
      author: "alice@example.com",
    });
  }

  test("bumps version on update", () => {
    seed();
    const { version } = mergeSkill({
      skillsRoot: root,
      name: "retry-webhooks",
      body: "v2 body",
      editor: "alice@example.com",
    });
    expect(version).toBe(2);
    const fm = listExistingSkills(root)[0]!.frontmatter!;
    expect(fm.version).toBe(2);
  });

  test("same-author update does not add a contributor", () => {
    seed();
    mergeSkill({
      skillsRoot: root,
      name: "retry-webhooks",
      body: "v2",
      editor: "alice@example.com",
    });
    expect(listExistingSkills(root)[0]!.frontmatter!.contributors).toEqual([]);
  });

  test("cross-author update appends the editor to contributors", () => {
    seed();
    mergeSkill({
      skillsRoot: root,
      name: "retry-webhooks",
      body: "v2",
      editor: "bob@example.com",
    });
    const fm = listExistingSkills(root)[0]!.frontmatter!;
    expect(fm.author).toBe("alice@example.com");
    expect(fm.contributors).toEqual(["bob@example.com"]);
  });

  test("replaces the body wholesale", () => {
    seed();
    mergeSkill({
      skillsRoot: root,
      name: "retry-webhooks",
      body: "completely new body",
      editor: "alice@example.com",
    });
    const body = listExistingSkills(root)[0]!.body;
    expect(body).toContain("completely new body");
    expect(body).not.toContain("v1 body");
  });

  test("throws when the target does not exist", () => {
    expect(() =>
      mergeSkill({
        skillsRoot: root,
        name: "ghost",
        body: "b",
          editor: "a@b.c",
      }),
    ).toThrow(/does not exist/);
  });
});

describe("listExistingSkills", () => {
  test("returns empty for a missing root", () => {
    expect(listExistingSkills(join(root, "nope"))).toEqual([]);
  });

  test("returns hand-written skills with null frontmatter instead of crashing", () => {
    const dir = join(root, "hand-written");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# Just a body, no frontmatter\n");
    const skills = listExistingSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.frontmatter).toBeNull();
    expect(skills[0]!.body).toContain("Just a body");
  });
});
