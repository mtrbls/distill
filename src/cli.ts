#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin, isInstalled, uninstallPlugin } from "./plugin.ts";
import { listExistingSkills, SKILLS_ROOT } from "./skill.ts";
import {
  markFirstRunNoticeShown,
  readConfig,
  resetInstallId,
  resolveTelemetry,
  setEndpointOverride,
  setTelemetryEnabled,
} from "./upskill/config.ts";
import { upskill } from "./upskill/index.ts";
import { buildTestTrace } from "./upskill/payload.ts";
import { emitTrace } from "./upskill/telemetry.ts";
import { VERSION } from "./version.ts";

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
  telemetry <sub>  status | on | off | endpoint <url> | reset-install-id | test
  enable           Re-enable auto-upskill (not yet implemented)
  disable          Stop auto-upskill (not yet implemented)
  upgrade          Self-update to the latest release (not yet implemented)
  hook <event>     Internal: hook entry point (counter|stop)
  _upskill         Internal: detached worker entry, same as upskill

OPTIONS
  --force          upskill: ignore watermark, rescan recent sessions
  --json           emit machine-readable JSON output
  --no-telemetry   disable telemetry for this command invocation
  -h, --help       show this message
  -v, --version    show version

--help with any command shows this message.`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
    return 0;
  }

  // Find the command: first arg that isn't a flag. Lets users put
  // global flags like --no-telemetry before or after the command.
  const cmdIdx = argv.findIndex((a) => !a.startsWith("-"));
  if (cmdIdx === -1) {
    if (argv.includes("-v") || argv.includes("--version")) {
      console.log(VERSION);
      return 0;
    }
    usage();
    return 0;
  }
  const cmd = argv[cmdIdx]!;
  const rest = argv.slice(cmdIdx + 1);
  const preCommandFlags = argv.slice(0, cmdIdx);
  const flags = parseFlags([...preCommandFlags, ...rest]);

  // --help anywhere wins over command dispatch. Without this check,
  // `distill upskill --help` would run a 30s LLM pass instead of
  // printing help.
  if (flags.help) {
    usage();
    return 0;
  }

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
    case "telemetry":
      return runTelemetry(rest[0] ?? "status", rest.slice(1), flags);
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
  noTelemetry: boolean;
}

function parseFlags(args: string[]): Flags {
  const f: Flags = { force: false, json: false, help: false, noTelemetry: false };
  for (const a of args) {
    if (a === "--force") f.force = true;
    else if (a === "--json") f.json = true;
    else if (a === "--no-telemetry") f.noTelemetry = true;
    else if (a === "-h" || a === "--help") f.help = true;
  }
  return f;
}

async function runUpskill(flags: Flags): Promise<number> {
  const startedAt = new Date().toISOString();
  if (!flags.json) {
    // Disclosure before the first emission, not after. The hook-spawned
    // worker (json mode, stdout ignored) never consumes the notice.
    maybeShowFirstRunNotice(flags.noTelemetry);
    console.log("distill upskill: scanning recent Claude Code sessions...");
  }
  const result = await upskill({ force: flags.force, noTelemetry: flags.noTelemetry });

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
    case "MERGE": {
      // The verdict alone isn't success: writeNewSkill/mergeSkill can
      // fail. skillPath is the proof the file landed on disk.
      if (!result.skillPath) {
        console.log(
          `distill upskill: ${result.verdict.verdict} verdict for '${result.verdict.name}' but writing failed`,
        );
        console.log(`              ${result.reason}`);
        return 1;
      }
      const action = result.verdict.verdict === "KEEP" ? "new skill" : "extended skill";
      console.log(`distill upskill: ${action} '${result.verdict.name}'`);
      console.log(`              ${result.skillPath}`);
      console.log(`              loads automatically in your next Claude Code session`);
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
    }
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

async function runInstall(flags: Flags): Promise<number> {
  if (flags.noTelemetry) {
    setTelemetryEnabled(false);
    markFirstRunNoticeShown();
  }
  const binary = resolveSelfPath();
  const result = installPlugin({ distillBinaryPath: binary });
  console.log(`distill: installed Claude Code plugin`);
  console.log(`         plugin dir: ${result.pluginDir}`);
  console.log(`         hooks:      ${result.hooksFile}`);
  console.log(`         binary:     ${binary}`);
  console.log("");
  console.log("Restart Claude Code to activate the hooks.");
  if (!flags.noTelemetry) {
    printFirstRunNotice();
    markFirstRunNoticeShown();
  } else {
    console.log("");
    console.log("Telemetry: disabled per --no-telemetry.");
    console.log("Re-enable anytime with: distill telemetry on");
  }
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

// ---------- telemetry subcommand ----------

async function runTelemetry(sub: string, args: string[], flags: Flags): Promise<number> {
  switch (sub) {
    case "":
    case "status":
      return showTelemetryStatus(flags.noTelemetry);
    case "on":
      setTelemetryEnabled(true);
      console.log("distill: telemetry enabled");
      return 0;
    case "off":
      setTelemetryEnabled(false);
      console.log("distill: telemetry disabled");
      return 0;
    case "endpoint":
      return setTelemetryEndpointCmd(args[0] ?? "");
    case "reset-install-id":
      {
        const id = resetInstallId();
        console.log(`distill: new install-id ${id}`);
      }
      return 0;
    case "test":
      return runTelemetryTest();
    default:
      console.error(`distill telemetry: unknown subcommand '${sub}'`);
      console.error("usage: distill telemetry {status|on|off|endpoint <url>|reset-install-id|test}");
      return 2;
  }
}

function showTelemetryStatus(noTelemetryFlag: boolean): number {
  const cfg = readConfig();
  const decision = resolveTelemetry({ noTelemetryFlag });
  console.log(`telemetry:   ${cfg.telemetry.enabled ? "on" : "off"}`);
  console.log(`mode:        ${cfg.mode}`);
  console.log(`endpoint:    ${decision.endpoint || "(none)"}`);
  console.log(`install-id:  ${cfg.telemetry.install_id}`);
  if (decision.emit) {
    console.log(`status:      emitting (${decision.reason})`);
  } else {
    console.log(`status:      not emitting (${decision.reason})`);
  }
  return 0;
}

function setTelemetryEndpointCmd(arg: string): number {
  if (!arg) {
    console.error("distill telemetry endpoint: provide a URL or 'default'");
    return 2;
  }
  if (arg === "default") {
    setEndpointOverride(null);
    console.log("distill: endpoint override cleared, using default");
    return 0;
  }
  try {
    new URL(arg);
  } catch {
    console.error(`distill telemetry endpoint: invalid URL '${arg}'`);
    return 2;
  }
  setEndpointOverride(arg);
  console.log(`distill: endpoint set to ${arg}`);
  return 0;
}

async function runTelemetryTest(): Promise<number> {
  const decision = resolveTelemetry();
  if (!decision.emit) {
    console.log(`distill telemetry test: telemetry disabled (${decision.reason})`);
    return 0;
  }
  console.log(`distill telemetry test: POSTing dummy span to ${decision.endpoint}...`);
  const trace = buildTestTrace();
  await emitTrace({ trace, decision });
  console.log("distill telemetry test: see ~/.distill/logs/upskill.log for the exporter's response.");
  return 0;
}

// ---------- first-run notice ----------

function maybeShowFirstRunNotice(noTelemetryFlag: boolean): void {
  const cfg = readConfig();
  if (cfg.telemetry.first_run_notice_shown) return;
  // Don't nag if the user already opted out for this run; they
  // know what they're doing. Mark as shown so we don't surprise
  // them later.
  if (noTelemetryFlag) {
    markFirstRunNoticeShown();
    return;
  }
  printFirstRunNotice();
  markFirstRunNoticeShown();
}

function printFirstRunNotice(): void {
  console.log("");
  console.log("distill: anonymous telemetry is on by default. counts and durations");
  console.log("         only, no prompt content, no skill bodies, no identity.");
  console.log("");
  console.log("         opt out:");
  console.log("           distill telemetry off                disable permanently");
  console.log("           DO_NOT_TRACK=1                       environment-level opt-out");
  console.log("           distill --no-telemetry <command>     per-command opt-out");
  console.log("");
  console.log("         details: https://distill.plouto.ai/telemetry");
}

// ---------- helpers ----------

async function gitEmail(): Promise<string> {
  try {
    const proc = Bun.spawnSync(["git", "config", "user.email"]);
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) return out;
  } catch {}
  return "unknown@local";
}

// Use process.exitCode (not process.exit) so the event loop can drain
// in-flight async work like the fire-and-forget telemetry emit before
// the process exits. The telemetry exporter has its own 5s timeout so
// this can't hang indefinitely.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`distill: fatal: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
