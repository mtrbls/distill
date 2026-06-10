import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { findCandidates } from "../src/upskill/discover.ts";
import { findRepoRoot } from "../src/upskill/index.ts";
import { DEFAULT_CONFIG } from "../src/upskill/types.ts";

let root: string;

const WATERMARK = { version: 1, lastDate: null, lastSessionUuid: null };

function writeSession(project: string, uuid: string): string {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${uuid}.jsonl`);
  writeFileSync(p, '{"type":"user"}\n');
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "distill-discover-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findCandidates active-session grace", () => {
  test("excludes a just-written session by default", () => {
    writeSession("-Users-alice-proj", "s1");
    const found = findCandidates({
      sessionsRoot: root,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: false,
    });
    expect(found).toHaveLength(0);
  });

  test("the triggering session is exempt from the grace window", () => {
    const trigger = writeSession("-Users-alice-proj", "s1");
    writeSession("-Users-alice-proj", "s2"); // also fresh, NOT the trigger
    const found = findCandidates({
      sessionsRoot: root,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: false,
      triggerPath: trigger,
    });
    expect(found.map((c) => c.sessionUuid)).toEqual(["s1"]);
  });
});

describe("findRepoRoot", () => {
  test("anchors at the repo root from any depth", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "packages", "api"), { recursive: true });
    expect(findRepoRoot(join(root, "repo", "packages", "api"))).toBe(join(root, "repo"));
    expect(findRepoRoot(join(root, "repo"))).toBe(join(root, "repo"));
  });

  test("a worktree/submodule .git FILE anchors too", () => {
    mkdirSync(join(root, "wt", "sub"), { recursive: true });
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere/repo/.git/worktrees/wt\n");
    expect(findRepoRoot(join(root, "wt", "sub"))).toBe(join(root, "wt"));
  });

  test("$HOME never anchors, even as a dotfiles repo", () => {
    mkdirSync(join(root, "home", ".git"), { recursive: true });
    mkdirSync(join(root, "home", "scratch"), { recursive: true });
    expect(findRepoRoot(join(root, "home", "scratch"), join(root, "home"))).toBeNull();
  });

  test("$HOME is a ceiling: ancestors of home never anchor either", () => {
    // repo ABOVE home (e.g. /Users as a repo on a shared machine)
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "home", "scratch"), { recursive: true });
    expect(findRepoRoot(join(root, "home", "scratch"), join(root, "home"))).toBeNull();
  });

  test("returns null outside any repo", () => {
    mkdirSync(join(root, "scratch"), { recursive: true });
    expect(findRepoRoot(join(root, "scratch"))).toBeNull();
  });
});

describe("findCandidates curator quarantine", () => {
  // same encoding Claude Code applies to session dirs
  const curatorDir = join(homedir(), ".distill", "curator").replace(/[/.]/g, "-");

  test("never mines the curator's own transcripts", () => {
    const p = writeSession(curatorDir, "c1");
    const found = findCandidates({
      sessionsRoot: root,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: true,
      triggerPath: p, // even as an explicit trigger
    });
    expect(found).toHaveLength(0);
  });

  test("a real project merely NAMED *distill-curator is still mined", () => {
    const p = writeSession("-Users-alice-work-distill-curator", "s1");
    const found = findCandidates({
      sessionsRoot: root,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: true,
      triggerPath: p,
    });
    expect(found).toHaveLength(1);
  });
});
