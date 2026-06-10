import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTeamName, materialize, type TeamPaths } from "../src/upskill/team.ts";
import type { TeamConfig } from "../src/upskill/config.ts";

// teamInit/share/pull shell out to git against module-level paths, so
// their round-trip lives in the manual e2e (see TEAM.md verification).
// materialize() is the part that deletes files; it gets real coverage
// here against injected temp roots.

let base: string;
let team: TeamConfig;
let paths: TeamPaths;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "distill-team-test-"));
  team = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "skills",
    remote: "git@example.com:org/skills.git",
    checkout: join(base, "checkout"),
    joined_at: "2026-06-10T00:00:00Z",
  };
  paths = { skillsRoot: join(base, "skills"), manifestPath: join(base, "manifest.json") };
  mkdirSync(team.checkout, { recursive: true });
  mkdirSync(paths.skillsRoot, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function repoSkill(name: string, body = "team body"): void {
  mkdirSync(join(team.checkout, name), { recursive: true });
  writeFileSync(join(team.checkout, name, "SKILL.md"), body);
}

function localSkill(name: string, body = "local body"): void {
  mkdirSync(join(paths.skillsRoot, name), { recursive: true });
  writeFileSync(join(paths.skillsRoot, name, "SKILL.md"), body);
}

describe("materialize", () => {
  test("installs new repo skills and records them in the manifest", () => {
    repoSkill("retry-webhooks");
    const r = materialize(team, paths);
    expect(r.added).toEqual(["retry-webhooks"]);
    expect(existsSync(join(paths.skillsRoot, "retry-webhooks", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf-8"));
    expect(manifest.skills).toEqual(["retry-webhooks"]);
    expect(manifest.team).toBe(team.id);
  });

  test("updates team-owned skills when the repo changes", () => {
    repoSkill("retry-webhooks", "v1");
    materialize(team, paths);
    repoSkill("retry-webhooks", "v2");
    const r = materialize(team, paths);
    expect(r.updated).toEqual(["retry-webhooks"]);
    expect(readFileSync(join(paths.skillsRoot, "retry-webhooks", "SKILL.md"), "utf-8")).toBe("v2");
  });

  test("removes team-owned skills that left the repo", () => {
    repoSkill("retry-webhooks");
    materialize(team, paths);
    rmSync(join(team.checkout, "retry-webhooks"), { recursive: true });
    const r = materialize(team, paths);
    expect(r.removed).toEqual(["retry-webhooks"]);
    expect(existsSync(join(paths.skillsRoot, "retry-webhooks"))).toBe(false);
  });

  test("never overwrites or removes a local skill it does not own", () => {
    localSkill("my-skill", "mine");
    repoSkill("my-skill", "theirs");
    const r = materialize(team, paths);
    expect(r.skipped).toEqual(["my-skill"]);
    expect(readFileSync(join(paths.skillsRoot, "my-skill", "SKILL.md"), "utf-8")).toBe("mine");
    // even across a second pull where the repo drops it
    rmSync(join(team.checkout, "my-skill"), { recursive: true });
    const r2 = materialize(team, paths);
    expect(r2.removed).toEqual([]);
    expect(existsSync(join(paths.skillsRoot, "my-skill", "SKILL.md"))).toBe(true);
  });

  test("ignores symlinked entries in the repo", () => {
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "escaped content");
    symlinkSync(outside, join(team.checkout, "sneaky-link"));
    // and a dir whose SKILL.md is itself a symlink
    mkdirSync(join(team.checkout, "half-sneaky"));
    symlinkSync(join(outside, "SKILL.md"), join(team.checkout, "half-sneaky", "SKILL.md"));

    const r = materialize(team, paths);
    expect(r.added).toEqual([]);
    expect(existsSync(join(paths.skillsRoot, "sneaky-link"))).toBe(false);
    expect(existsSync(join(paths.skillsRoot, "half-sneaky"))).toBe(false);
  });

  test("ignores repo entries with invalid skill names", () => {
    repoSkill("ok-name");
    mkdirSync(join(team.checkout, "Bad Name"), { recursive: true });
    writeFileSync(join(team.checkout, "Bad Name", "SKILL.md"), "x");
    const r = materialize(team, paths);
    expect(r.added).toEqual(["ok-name"]);
  });
});

describe("deriveTeamName", () => {
  test("derives from ssh urls", () => {
    expect(deriveTeamName("git@github.com:org/skills.git")).toBe("skills");
    expect(deriveTeamName("git@github.com:org/Team-Skills.git")).toBe("team-skills");
  });

  test("derives from https urls", () => {
    expect(deriveTeamName("https://github.com/org/claude-skills.git")).toBe("claude-skills");
    expect(deriveTeamName("https://github.com/org/claude-skills")).toBe("claude-skills");
  });

  test("tolerates trailing slashes", () => {
    expect(deriveTeamName("https://github.com/org/skills/")).toBe("skills");
  });

  test("rejects names that would be unsafe directory names", () => {
    expect(deriveTeamName("")).toBeNull();
    expect(deriveTeamName("git@github.com:org/..git")).toBeNull();
  });
});
