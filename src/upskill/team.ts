// Team skills over plain git. The checkout lives in
// ~/.distill/team/<name>/ and `pull` materializes skill dirs flat
// into ~/.claude/skills/ where Claude Code (and the curator) look.
// A manifest tracks which local names are team-owned so pulls can
// update/remove them without ever touching the user's own skills.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { isValidSkillName, SKILLS_ROOT } from "../skill.ts";
import { readConfig, setTeam, type TeamConfig } from "./config.ts";

const log = createLogger("team");

const DISTILL_HOME = join(homedir(), ".distill");
const TEAM_ROOT = join(DISTILL_HOME, "team");
const MANIFEST_PATH = join(DISTILL_HOME, "team-manifest.json");

export interface TeamResult {
  ok: boolean;
  reason: string;
}

export interface PullResult extends TeamResult {
  added: string[];
  updated: string[];
  removed: string[];
  skipped: string[];
}

// ---------- git plumbing ----------

function git(cwd: string | null, args: string[]): { ok: boolean; out: string; err: string } {
  const cmd = cwd ? ["git", "-C", cwd, ...args] : ["git", ...args];
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout).trim();
    const err = new TextDecoder().decode(proc.stderr).trim();
    return { ok: proc.exitCode === 0, out, err };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

// Fail closed before any write: `git -C` walks UP the tree when the
// dir isn't a repo, so a missing .git could land commits in a parent
// repo (e.g. a dotfiles repo in $HOME). Confirm the checkout is its
// own repo root and points at the configured remote.
function verifyCheckout(team: TeamConfig): string | null {
  const top = git(team.checkout, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out !== team.checkout) {
    return `checkout at ${team.checkout} is not a git repo root`;
  }
  const origin = git(team.checkout, ["remote", "get-url", "origin"]);
  if (!origin.ok || origin.out !== team.remote) {
    return `checkout origin '${origin.out}' does not match team remote '${team.remote}'`;
  }
  return null;
}

// ---------- manifest ----------

interface Manifest {
  team: string;
  skills: string[];
}

// injectable for tests; defaults are the real locations
export interface TeamPaths {
  skillsRoot: string;
  manifestPath: string;
}

const DEFAULT_PATHS: TeamPaths = {
  skillsRoot: SKILLS_ROOT,
  manifestPath: MANIFEST_PATH,
};

function readManifest(path: string): Manifest {
  if (!existsSync(path)) return { team: "", skills: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<Manifest>;
    return { team: raw.team ?? "", skills: Array.isArray(raw.skills) ? raw.skills : [] };
  } catch {
    return { team: "", skills: [] };
  }
}

function writeManifest(m: Manifest, path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
}

// ---------- init / leave ----------

export function teamInit(gitUrl: string): TeamResult {
  const existing = readConfig().team;
  if (existing) {
    return { ok: false, reason: `already on team '${existing.name}' (distill team leave first)` };
  }

  // the checkout dir is a uuid: no user input near the filesystem, no
  // collisions on rejoin, and a ready-made Plouto workspace mapping key
  const id = crypto.randomUUID();
  const name = deriveTeamName(gitUrl) ?? "team";
  const checkout = join(TEAM_ROOT, id);

  mkdirSync(TEAM_ROOT, { recursive: true });
  log(`cloning ${gitUrl} -> ${checkout}`);
  const clone = git(null, ["clone", gitUrl, checkout]);
  if (!clone.ok) {
    return { ok: false, reason: `git clone failed: ${clone.err.slice(0, 200)}` };
  }

  const team: TeamConfig = {
    id,
    name,
    remote: gitUrl,
    checkout,
    joined_at: new Date().toISOString(),
  };
  setTeam(team);
  writeManifest({ team: id, skills: [] }, DEFAULT_PATHS.manifestPath);
  log(`joined team '${name}' (${id})`);
  return { ok: true, reason: "" };
}

export function teamLeave(): TeamResult {
  const team = readConfig().team;
  if (!team) return { ok: false, reason: "not on a team" };
  setTeam(null);
  // materialized skills stay in ~/.claude/skills; the checkout stays
  // on disk too in case there are unpushed changes
  log(`left team '${team.name}' (checkout kept at ${team.checkout})`);
  return { ok: true, reason: "" };
}

export function deriveTeamName(gitUrl: string): string | null {
  const tail = gitUrl.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = tail.replace(/\.git$/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) ? name : null;
}

// ---------- share ----------

export function teamShare(skillName: string): TeamResult {
  const team = readConfig().team;
  if (!team) return { ok: false, reason: "not on a team (distill team init <git-url>)" };

  // the name lands in path joins and a git commit message; allow only
  // real skill names
  if (!isValidSkillName(skillName)) {
    return { ok: false, reason: `invalid skill name '${skillName}'` };
  }
  const bad = verifyCheckout(team);
  if (bad) return { ok: false, reason: bad };

  const src = join(SKILLS_ROOT, skillName);
  if (!existsSync(join(src, "SKILL.md"))) {
    return { ok: false, reason: `no skill at ${src}` };
  }

  const dest = join(team.checkout, skillName);
  const isUpdate = existsSync(dest);
  cpSync(src, dest, { recursive: true });

  const version = readVersion(join(dest, "SKILL.md"));
  const message = isUpdate
    ? `update skill: ${skillName}${version ? ` v${version}` : ""}`
    : `add skill: ${skillName}`;

  const add = git(team.checkout, ["add", skillName]);
  if (!add.ok) return { ok: false, reason: `git add failed: ${add.err.slice(0, 200)}` };

  const commit = git(team.checkout, ["commit", "-m", message]);
  if (!commit.ok) {
    if (commit.out.includes("nothing to commit") || commit.err.includes("nothing to commit")) {
      return { ok: true, reason: "already up to date" };
    }
    return { ok: false, reason: `git commit failed: ${commit.err.slice(0, 200)}` };
  }

  const push = git(team.checkout, ["push"]);
  if (!push.ok) {
    return { ok: false, reason: `committed locally but push failed: ${push.err.slice(0, 200)}` };
  }

  const manifest = readManifest(DEFAULT_PATHS.manifestPath);
  if (!manifest.skills.includes(skillName)) {
    manifest.skills.push(skillName);
    manifest.team = team.id;
    writeManifest(manifest, DEFAULT_PATHS.manifestPath);
  }
  log(`shared ${skillName} (${message})`);
  return { ok: true, reason: message };
}

function readVersion(skillMd: string): string | null {
  try {
    const m = readFileSync(skillMd, "utf-8").match(/^version:\s*(\d+)/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------- pull / materialize ----------

export function teamPull(): PullResult {
  const none: PullResult = { ok: false, reason: "", added: [], updated: [], removed: [], skipped: [] };
  const team = readConfig().team;
  if (!team) return { ...none, reason: "not on a team" };

  const bad = verifyCheckout(team);
  if (bad) {
    log(`pull refused: ${bad}`);
    return { ...none, reason: bad };
  }
  const pull = git(team.checkout, ["pull", "--ff-only"]);
  if (!pull.ok) {
    log(`pull failed: ${pull.err.slice(0, 200)}`);
    return { ...none, reason: `git pull failed: ${pull.err.slice(0, 200)}` };
  }

  return materialize(team);
}

// exported for tests (no git involved: reads the checkout dir as-is)
export function materialize(team: TeamConfig, paths: TeamPaths = DEFAULT_PATHS): PullResult {
  const result: PullResult = { ok: true, reason: "", added: [], updated: [], removed: [], skipped: [] };
  const manifest = readManifest(paths.manifestPath);
  const owned = new Set(manifest.skills);

  // skills currently in the repo. lstat on purpose: a symlinked dir or
  // SKILL.md in a team repo could point anywhere on the local disk,
  // so symlinks don't materialize, full stop.
  const repoSkills = new Set<string>();
  for (const entry of readdirSync(team.checkout)) {
    if (entry.startsWith(".") || !isValidSkillName(entry)) continue;
    const dir = join(team.checkout, entry);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      if (!lstatSync(join(dir, "SKILL.md")).isFile()) continue;
    } catch {
      continue;
    }
    repoSkills.add(entry);
  }

  for (const name of repoSkills) {
    const src = join(team.checkout, name);
    const dest = join(paths.skillsRoot, name);
    const destExists = existsSync(join(dest, "SKILL.md"));

    if (destExists && !owned.has(name)) {
      // the user's own skill wins; never silently overwrite it
      result.skipped.push(name);
      continue;
    }
    if (destExists && sameContent(join(src, "SKILL.md"), join(dest, "SKILL.md"))) {
      continue;
    }
    cpSync(src, dest, { recursive: true });
    (destExists ? result.updated : result.added).push(name);
    owned.add(name);
  }

  // team-owned names that left the repo get removed locally
  for (const name of [...owned]) {
    if (repoSkills.has(name)) continue;
    const dest = join(paths.skillsRoot, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    owned.delete(name);
    result.removed.push(name);
  }

  writeManifest({ team: team.id, skills: [...owned].sort() }, paths.manifestPath);
  if (result.added.length || result.updated.length || result.removed.length) {
    log(
      `materialized: +${result.added.length} ~${result.updated.length} -${result.removed.length}` +
        (result.skipped.length ? ` (skipped ${result.skipped.join(", ")}: local name collision)` : ""),
    );
  }
  return result;
}

function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf-8") === readFileSync(b, "utf-8");
  } catch {
    return false;
  }
}
