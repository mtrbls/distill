import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCandidates } from "../src/upskill/discover.ts";
import { findProjectRoot } from "../src/upskill/index.ts";
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

describe("findProjectRoot", () => {
  test("finds the git root from a nested subdirectory", () => {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "packages", "api"), { recursive: true });
    expect(findProjectRoot(join(root, "repo", "packages", "api"))).toBe(join(root, "repo"));
    expect(findProjectRoot(join(root, "repo"))).toBe(join(root, "repo"));
  });

  test("an existing .claude dir anchors without any git", () => {
    mkdirSync(join(root, "ws", ".claude"), { recursive: true });
    mkdirSync(join(root, "ws", "notes"), { recursive: true });
    expect(findProjectRoot(join(root, "ws", "notes"))).toBe(join(root, "ws"));
  });

  test("a subproject's own .claude wins over the repo root above it", () => {
    mkdirSync(join(root, "mono", ".git"), { recursive: true });
    mkdirSync(join(root, "mono", "svc", ".claude"), { recursive: true });
    mkdirSync(join(root, "mono", "svc", "src"), { recursive: true });
    expect(findProjectRoot(join(root, "mono", "svc", "src"))).toBe(join(root, "mono", "svc"));
  });

  test("$HOME never anchors, even as a dotfiles repo", () => {
    mkdirSync(join(root, "home", ".git"), { recursive: true });
    mkdirSync(join(root, "home", ".claude"), { recursive: true });
    mkdirSync(join(root, "home", "scratch"), { recursive: true });
    expect(findProjectRoot(join(root, "home", "scratch"), join(root, "home"))).toBeNull();
  });

  test("returns null outside any project", () => {
    mkdirSync(join(root, "scratch"), { recursive: true });
    expect(findProjectRoot(join(root, "scratch"))).toBeNull();
  });
});

describe("findCandidates curator quarantine", () => {
  test("never mines the curator's own transcripts", () => {
    const p = writeSession("-Users-alice--distill-curator", "c1");
    const found = findCandidates({
      sessionsRoot: root,
      watermark: WATERMARK,
      config: DEFAULT_CONFIG,
      force: true,
      triggerPath: p, // even as an explicit trigger
    });
    expect(found).toHaveLength(0);
  });
});
