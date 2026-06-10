import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCandidates } from "../src/upskill/discover.ts";
import { findCollectAnchor, findProjectRoot, resolveAnchor } from "../src/upskill/index.ts";
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

function markProject(dir: string): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "distill.json"), '{ "version": 1 }\n');
}

describe("findProjectRoot", () => {
  test("anchors at the nearest distill marker, from any depth", () => {
    markProject(join(root, "ws"));
    mkdirSync(join(root, "ws", "packages", "api"), { recursive: true });
    expect(findProjectRoot(join(root, "ws", "packages", "api"))).toBe(join(root, "ws"));
    expect(findProjectRoot(join(root, "ws"))).toBe(join(root, "ws"));
  });

  test("a bare .claude dir is NOT consent — only the marker anchors", () => {
    // .claude exists because someone approved a permission once
    mkdirSync(join(root, "repo", ".claude"), { recursive: true });
    writeFileSync(join(root, "repo", ".claude", "settings.local.json"), "{}\n");
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    expect(findProjectRoot(join(root, "repo", "src"))).toBeNull();
  });

  test("a subproject's own marker wins over one further up", () => {
    markProject(join(root, "mono"));
    markProject(join(root, "mono", "svc"));
    mkdirSync(join(root, "mono", "svc", "src"), { recursive: true });
    expect(findProjectRoot(join(root, "mono", "svc", "src"))).toBe(join(root, "mono", "svc"));
  });

  test("$HOME never anchors", () => {
    markProject(join(root, "home"));
    mkdirSync(join(root, "home", "scratch"), { recursive: true });
    expect(findProjectRoot(join(root, "home", "scratch"), join(root, "home"))).toBeNull();
  });

  test("$HOME is a ceiling: ancestors of home never anchor either", () => {
    // marker ABOVE home (e.g. /Users/.claude on a shared machine)
    markProject(root);
    mkdirSync(join(root, "home", "scratch"), { recursive: true });
    expect(findProjectRoot(join(root, "home", "scratch"), join(root, "home"))).toBeNull();
  });

  test("returns null outside any project", () => {
    mkdirSync(join(root, "scratch"), { recursive: true });
    expect(findProjectRoot(join(root, "scratch"))).toBeNull();
  });
});

describe("findCollectAnchor", () => {
  test("inside a collect root, the git toplevel anchors", () => {
    mkdirSync(join(root, "w", "proj", ".git"), { recursive: true });
    mkdirSync(join(root, "w", "proj", "src"), { recursive: true });
    expect(findCollectAnchor(join(root, "w", "proj", "src"), [join(root, "w")]))
      .toBe(join(root, "w", "proj"));
  });

  test("inside a collect root but outside any repo: no anchor", () => {
    mkdirSync(join(root, "w", "notes"), { recursive: true });
    expect(findCollectAnchor(join(root, "w", "notes"), [join(root, "w")])).toBeNull();
  });

  test("outside every collect root: no anchor", () => {
    mkdirSync(join(root, "elsewhere", "proj", ".git"), { recursive: true });
    expect(findCollectAnchor(join(root, "elsewhere", "proj"), [join(root, "w")])).toBeNull();
  });

  test("never anchors above the collect root", () => {
    // repo ABOVE the collect root must not capture work under it
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "w", "notes"), { recursive: true });
    expect(findCollectAnchor(join(root, "w", "notes"), [join(root, "w")])).toBeNull();
  });
});

describe("resolveAnchor", () => {
  test("a committed marker wins over the collect-root git boundary", () => {
    mkdirSync(join(root, "w", "proj", ".git"), { recursive: true });
    markProject(join(root, "w", "proj", "svc"));
    mkdirSync(join(root, "w", "proj", "svc", "src"), { recursive: true });
    expect(resolveAnchor(join(root, "w", "proj", "svc", "src"), [join(root, "w")]))
      .toBe(join(root, "w", "proj", "svc"));
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
