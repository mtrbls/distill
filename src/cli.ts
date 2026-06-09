#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin, isInstalled, uninstallPlugin } from "./plugin.ts";
import { listExistingSkills, SKILLS_ROOT } from "./skill.ts";
import { upskill } from "./upskill/index.ts";

const VERSION = "0.1.0";
const DISTILL_HOME = join(homedir(), ".distill");
const STATE_PATH = join(DISTILL_HOME, "state.json");
const COUNTER_PATH = join(DISTILL_HOME, "counter.json");
const TURNS_THRESHOLD = 30;

function usage(): void {
  console.log(`distill ${VERSION}

Distill reusable skills from your Claude Code sessions.

USAGE
  distill <command> [options]

COMMANDS
  upskill          Review recent Claude Code sessions for new skills
  status           Show mode, storage, skill counts, last upskill run
  install          Register the Claude Code plugin (hooks + manifest)
  uninstall        Remove the Claude Code plugin registration
  enable           Re-enable auto-upskill (not yet implemented)
  disable          Stop auto-upskill (not yet implemented)
  upgrade          Self-update to the latest release (not yet implemented)
  hook <event>     Internal: hook entry point (counter|stop)
  _upskill         Internal: detached worker entry, same as upskill

OPTIONS
  --force          upskill: ignore watermark, rescan recent sessions
  --json           emit machine-readable JSON output
  -h, --help       show this message
  -v, --version    show version

Run 'distill <command> --help' for command-specific help.`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    return 0;
  }
  const cmd = argv[0]!;
  const rest = argv.slice(1);
  const flags = parseFlags(rest);

  switch (cmd) {
    case "-h":
    case "--help":
      usage();
      return 0;
    case "-v":
    case "--version":
      console.log(VERSION);
      return 0;
    case "upskill":
      return runUpskill(flags);
    case "_upskill":
      return runUpskill({ ...flags, json: true });
    case "status":
      return runStatus(flags);
    case "hook":
      return runHook(rest[0] ?? "", flags);
    case "install":
      return runInstall(flags);
    case "uninstall":
      return runUninstall(flags);
    case "enable":
    case "disable":
    case "upgrade":
      console.error(`distill ${cmd}: not yet implemented`);
      return 2;
    default:
      console.error(`distill: unknown command '${cmd}'`);
      console.error("run 'distill --help' for usage");
      return 2;
  }
}

interface Flags {
  force: boolean;
  json: boolean;
  help: boolean;
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { force: false, json: false, help: false };
  for (const a of args) {
    if (a === "--force") f.force = true;
    else if (a === "--json") f.json = true;
    else if (a === "-h" || a === "--help") f.help = true;
  }
  return f;
}

async function runUpskill(flags: Flags): Promise<number> {
  const startedAt = new Date().toISOString();
  if (!flags.json) {
    console.log("distill upskill: scanning recent Claude Code sessions...");
  }
  const result = await upskill({ force: flags.force });

  if (flags.json) {
    console.log(JSON.stringify({ startedAt, ...result }, null, 2));
    return 0;
  }

  if (result.scanned === 0) {
    console.log(`distill upskill: ${result.reason}`);
    console.log("              run with --force to ignore the watermark and rescan.");
    return 0;
  }

  if (!result.verdict) {
    console.log(`distill upskill: scanned ${result.scanned} session(s), ${result.reason}`);
    return 1;
  }

  switch (result.verdict.verdict) {
    case "KEEP":
      console.log(`distill upskill: drafted skill '${result.verdict.name}'`);
      if (result.skillPath) console.log(`              ${result.skillPath}`);
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
    case "MERGE":
      console.log(`distill upskill: extended skill '${result.verdict.name}'`);
      if (result.skillPath) console.log(`              ${result.skillPath}`);
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
    case "SKIP":
      console.log(`distill upskill: no skill from ${result.scanned} session(s)`);
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
  }
}

async function runStatus(flags: Flags): Promise<number> {
  const skills = listExistingSkills();
  const minedSkills = skills.filter((s) => s.frontmatter?.created_by === "distill");
  const untrackedSkills = skills.length - minedSkills.length;

  let lastMine: string | null = null;
  if (existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
      lastMine = raw.lastDate ?? null;
    } catch {
      // ignore
    }
  }

  const identity = await gitEmail();

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          mode: "individual",
          storage: SKILLS_ROOT,
          skills: { mined: minedSkills.length, untracked: untrackedSkills },
          lastMine,
          identity,
          version: VERSION,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`distill ${VERSION}\n`);
  console.log(`Mode:        individual (local-only)`);
  console.log(`Storage:     ${SKILLS_ROOT}`);
  console.log(
    `Skills:      ${minedSkills.length} mined by distill, ${untrackedSkills} other`,
  );
  console.log(`Last run:    ${lastMine ?? "never"}`);
  console.log(`Identity:    ${identity}`);
  return 0;
}

async function runHook(event: string, _flags: Flags): Promise<number> {
  // Hook handlers MUST exit 0 even on error so they never break the agent.
  try {
    switch (event) {
      case "counter": {
        const next = bumpCounter();
        if (next >= TURNS_THRESHOLD) {
          spawnUpskillDetached();
          resetCounter();
        }
        return 0;
      }
      case "stop": {
        spawnUpskillDetached();
        resetCounter();
        return 0;
      }
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

async function runInstall(_flags: Flags): Promise<number> {
  const binary = resolveSelfPath();
  const result = installPlugin({ distillBinaryPath: binary });
  console.log(`distill: installed Claude Code plugin`);
  console.log(`         plugin dir: ${result.pluginDir}`);
  console.log(`         hooks:      ${result.hooksFile}`);
  console.log(`         binary:     ${binary}`);
  console.log("");
  console.log("Restart Claude Code to activate the hooks.");
  return 0;
}

async function runUninstall(_flags: Flags): Promise<number> {
  if (!isInstalled()) {
    console.log("distill: plugin is not registered, nothing to do");
    return 0;
  }
  const { removed } = uninstallPlugin();
  console.log(`distill: removed plugin registration:`);
  for (const r of removed) console.log(`         - ${r}`);
  console.log("");
  console.log("Skills in ~/.claude/skills/ are preserved.");
  console.log("Restart Claude Code so it stops loading the hooks.");
  return 0;
}

// ---------- counter helpers ----------

function bumpCounter(): number {
  mkdirSync(DISTILL_HOME, { recursive: true });
  let counter = 0;
  if (existsSync(COUNTER_PATH)) {
    try {
      counter = Number(JSON.parse(readFileSync(COUNTER_PATH, "utf-8")).counter) || 0;
    } catch {
      counter = 0;
    }
  }
  counter += 1;
  writeFileSync(COUNTER_PATH, JSON.stringify({ counter }) + "\n");
  return counter;
}

function resetCounter(): void {
  try {
    writeFileSync(COUNTER_PATH, JSON.stringify({ counter: 0 }) + "\n");
  } catch {
    // ignore
  }
}

function spawnUpskillDetached(): void {
  const selfPath = resolveSelfPath();
  try {
    const proc = Bun.spawn([selfPath, "_upskill"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    proc.unref();
  } catch {
    // ignore: hook never blocks the agent
  }
}

function resolveSelfPath(): string {
  // When running via the compiled binary, argv[0] is the binary path.
  // When running via `bun src/cli.ts`, we fall back to a `distill` PATH lookup.
  const argv0 = process.argv[0] ?? "distill";
  if (argv0.endsWith("/distill") || argv0.endsWith("\\distill")) {
    return resolve(argv0);
  }
  return "distill";
}

async function gitEmail(): Promise<string> {
  try {
    const proc = Bun.spawnSync(["git", "config", "user.email"]);
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) return out;
  } catch {}
  return "unknown@local";
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`distill: fatal: ${e?.message ?? e}`);
    process.exit(2);
  });
