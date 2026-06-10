// Team skills over plain git. The checkout lives in
// ~/.distill/team/<name>/ and `pull` materializes skill dirs flat
// into ~/.claude/skills/ where Claude Code (and the curator) look.
// A manifest tracks which local names are team-owned so pulls can
// update/remove them without ever touching the user's own skills.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "../log.ts";
import { SKILLS_ROOT } from "../skill.ts";
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

// ---------- manifest ----------

interface Manifest {
  team: string;
  skills: string[];
}

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) return { team: "", skills: [] };
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Partial<Manifest>;
    return { team: raw.team ?? "", skills: Array.isArray(raw.skills) ? raw.skills : [] };
  } catch {
    return { team: "", skills: [] };
  }
}

function writeManifest(m: Manifest): void {
  mkdirSync(DISTILL_HOME, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

// ---------- init / leave ----------

export function teamInit(gitUrl: string, nameOverride?: string): TeamResult {
  const existing = readConfig().team;
  if (existing) {
    return { ok: false, reason: `already on team '${existing.name}' (distill team leave first)` };
  }

  const name = nameOverride ?? deriveTeamName(gitUrl);
  if (!name) return { ok: false, reason: `could not derive a team name from '${gitUrl}'` };
  const checkout = join(TEAM_ROOT, name);
  if (existsSync(checkout)) {
    return { ok: false, reason: `checkout already exists at ${checkout}` };
  }

  mkdirSync(TEAM_ROOT, { recursive: true });
  log(`cloning ${gitUrl} -> ${checkout}`);
  const clone = git(null, ["clone", gitUrl, checkout]);
  if (!clone.ok) {
    return { ok: false, reason: `git clone failed: ${clone.err.slice(0, 200)}` };
  }

  const team: TeamConfig = {
    name,
    remote: gitUrl,
    checkout,
    joined_at: new Date().toISOString(),
  };
  setTeam(team);
  writeManifest({ team: name, skills: [] });
  log(`joined team '${name}'`);
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

  const manifest = readManifest();
  if (!manifest.skills.includes(skillName)) {
    manifest.skills.push(skillName);
    manifest.team = team.name;
    writeManifest(manifest);
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

  const pull = git(team.checkout, ["pull", "--ff-only"]);
  if (!pull.ok) {
    log(`pull failed: ${pull.err.slice(0, 200)}`);
    return { ...none, reason: `git pull failed: ${pull.err.slice(0, 200)}` };
  }

  return materialize(team);
}

function materialize(team: TeamConfig): PullResult {
  const result: PullResult = { ok: true, reason: "", added: [], updated: [], removed: [], skipped: [] };
  const manifest = readManifest();
  const owned = new Set(manifest.skills);

  // skills currently in the repo
  const repoSkills = new Set<string>();
  for (const entry of readdirSync(team.checkout)) {
    if (entry.startsWith(".")) continue;
    const dir = join(team.checkout, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, "SKILL.md"))) repoSkills.add(entry);
  }

  for (const name of repoSkills) {
    const src = join(team.checkout, name);
    const dest = join(SKILLS_ROOT, name);
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
    const dest = join(SKILLS_ROOT, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    owned.delete(name);
    result.removed.push(name);
  }

  writeManifest({ team: team.name, skills: [...owned].sort() });
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
