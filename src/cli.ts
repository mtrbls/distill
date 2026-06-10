#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installPlugin, isInstalled, uninstallPlugin } from "./plugin.ts";
import { listExistingSkills, SKILLS_ROOT } from "./skill.ts";
import { listCandidates } from "./upskill/candidates.ts";
import { installStarterSkills } from "./starter.ts";
import {
  readConfig,
  resetInstallId,
  resolveTelemetry,
  setTelemetryEnabled,
} from "./upskill/config.ts";
import { findProjectRoot, PROJECT_MARKER, upskill } from "./upskill/index.ts";
import { buildTestRecord } from "./upskill/payload.ts";
import {
  connectViaBrowser,
  connectWithToken,
  DEFAULT_PLOUTO_API,
  disconnect,
  syncRecent,
} from "./upskill/plouto.ts";
import { emitLogs } from "./upskill/telemetry.ts";
import { listSessionFiles, summarizeUsage } from "./upskill/usage.ts";
import { VERSION } from "./version.ts";

const DISTILL_HOME = join(homedir(), ".distill");
const STATE_PATH = join(DISTILL_HOME, "state.json");
const COUNTER_PATH = join(DISTILL_HOME, "counter.json");
// user prompts between mid-session mining attempts (long-lived
// sessions never hit the Stop hook, so this is their only trigger)
const PROMPTS_THRESHOLD = 20;

function usage(): void {
  console.log(`distill ${VERSION}

Distill reusable skills from your Claude Code sessions.

USAGE
  distill <command> [options]

COMMANDS
  init             Opt this project in: mined skills land in its .claude/
  upskill          Review recent Claude Code sessions for new skills
  usage            Token + tool usage from your local sessions
  status           Show mode, storage, skill counts, last upskill run
  connect          Link this install to your Plouto workspace
  disconnect       Unlink from Plouto (local data stays)
  sync             Push recent session metadata to your workspace
  install          Register the Claude Code plugin (hooks + manifest)
  uninstall        Remove the Claude Code plugin registration
  telemetry <sub>  status | on | off | reset-install-id | test
  upgrade          Self-update to the latest release (not yet implemented)
  hook <event>     Internal: hook entry point (counter|stop)
  _upskill         Internal: detached worker entry, same as upskill

OPTIONS
  --force          upskill: ignore watermark, rescan recent sessions
  --days <n>       usage: window size (default 30)
  --token <t>      connect: skip the browser, use this token
  --api-url <u>    connect: target API (default ${DEFAULT_PLOUTO_API})
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

  // first non-flag arg is the command; flags can go on either side
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

  // --help wins before dispatch, otherwise `upskill --help` would run
  // a real pass
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
    case "init":
      return runInit();
    case "upskill":
      return runUpskill(flags);
    case "probe":
      return runProbe(flags);
    case "_upskill":
      return runUpskill({ ...flags, json: true }, flagValue(rest, "--transcript") ?? undefined);
    case "usage":
      return runUsage(flags, rest);
    case "sync":
      return runSync(flags);
    case "connect":
      return runConnect(rest);
    case "disconnect":
      return runDisconnect();
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

function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  const v = args[i + 1]!;
  return v.startsWith("--") ? null : v;
}

async function runInit(): Promise<number> {
  const root = process.cwd();
  if (root === homedir()) {
    console.error("distill init: home is the global scope already; run this inside a project");
    return 2;
  }
  const marker = join(root, PROJECT_MARKER);
  if (existsSync(marker)) {
    console.log(`distill: already initialized (${marker})`);
    return 0;
  }
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(marker, JSON.stringify({ version: 1 }, null, 2) + "\n");
  console.log(`distill: this project now collects mined skills`);
  console.log(`         marker:     ${marker}`);
  console.log(`         skills:     ${join(root, ".claude", "skills")}`);
  console.log(`         candidates: ${join(root, ".claude", "skill-candidates")}`);
  console.log("");
  console.log("Commit the marker so your team's distill collects here too.");
  return 0;
}

async function runUpskill(flags: Flags, triggerTranscript?: string): Promise<number> {
  const startedAt = new Date().toISOString();
  if (!flags.json) {
    console.log("distill upskill: scanning recent Claude Code sessions...");
  }
  const result = await upskill({
    force: flags.force,
    noTelemetry: flags.noTelemetry,
    triggerTranscript,
  });

  // connected installs push session metadata after each pass
  const cfg = readConfig();
  if (cfg.plouto?.token) {
    const sync = await syncRecent();
    if (!flags.json && sync.sessionsSynced > 0) {
      console.log(`distill sync: pushed ${sync.sessionsSynced} session(s) to your workspace`);
    }
  }

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
    case "CREATE":
    case "UPDATE":
    case "PROMOTE": {
      // skillPath is the proof the write actually happened
      if (!result.skillPath) {
        console.log(
          `distill upskill: ${result.verdict.verdict} verdict for '${result.verdict.name}' but writing failed`,
        );
        console.log(`              ${result.reason}`);
        return 1;
      }
      const v = result.verdict.verdict;
      const action =
        v === "UPDATE" ? "updated skill"
        : v === "PROMOTE" ? "promoted skill"
        : result.tier === "candidate" ? "new candidate" : "new skill";
      console.log(`distill upskill: ${action} '${result.verdict.name}'`);
      console.log(`              ${result.skillPath}`);
      if (result.tier === "candidate") {
        console.log(`              dormant; activates when the pattern recurs`);
      } else {
        console.log(`              loads automatically in your next Claude Code session`);
      }
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
    }
    case "SKIP":
      console.log(`distill upskill: no skill from ${result.scanned} session(s)`);
      if (result.verdict.reason) console.log(`              reason: ${result.verdict.reason}`);
      return 0;
  }
}

async function runUsage(flags: Flags, args: string[]): Promise<number> {
  const days = Number(flagValue(args, "--days")) || 30;
  const sessionsRoot = join(homedir(), ".claude", "projects");
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = listSessionFiles(sessionsRoot, since);
  const summary = summarizeUsage(files);

  if (flags.json) {
    console.log(JSON.stringify({ days, ...summary }, null, 2));
    return 0;
  }

  console.log(`distill usage: last ${days} days, ${summary.sessions} session(s)\n`);

  const models = Object.entries(summary.models).sort(
    (a, b) => b[1].outputTokens - a[1].outputTokens,
  );
  if (models.length === 0) {
    console.log("No assistant activity found in this window.");
    return 0;
  }

  console.log("Tokens by model:");
  for (const [model, m] of models) {
    console.log(`  ${model}`);
    console.log(
      `    in ${fmt(m.inputTokens)}  out ${fmt(m.outputTokens)}  cache-read ${fmt(m.cacheReadTokens)}  cache-write ${fmt(m.cacheCreationTokens)}  (${m.messages} messages)`,
    );
  }

  const tools = Object.entries(summary.tools).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (tools.length > 0) {
    console.log("\nTop tools:");
    for (const [name, count] of tools) console.log(`  ${String(count).padStart(6)}  ${name}`);
    if (summary.mcpToolCalls > 0) {
      console.log(`  ${String(summary.mcpToolCalls).padStart(6)}  (mcp tools)`);
    }
  }

  const skills = Object.entries(summary.skillsInvoked).sort((a, b) => b[1] - a[1]);
  if (skills.length > 0) {
    console.log("\nSkills invoked:");
    for (const [name, count] of skills) console.log(`  ${String(count).padStart(6)}  ${name}`);
  }
  return 0;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

async function runSync(flags: Flags): Promise<number> {
  const result = await syncRecent();
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    console.log(`distill sync: failed (${result.reason})`);
    if (result.reason === "not connected") {
      console.log("           run `distill connect` first");
    }
    return 1;
  }
  if (result.sessionsSynced === 0) {
    console.log(`distill sync: ${result.reason}`);
    return 0;
  }
  console.log(
    `distill sync: ${result.sessionsSynced} session(s) pushed, server upserted ${result.sessionsUpserted} sessions / ${result.turnsUpserted} turns`,
  );
  return 0;
}

async function runConnect(args: string[]): Promise<number> {
  const apiUrl = flagValue(args, "--api-url") ?? DEFAULT_PLOUTO_API;
  const token = flagValue(args, "--token");

  const result = token
    ? connectWithToken(token, apiUrl)
    : await connectViaBrowser(apiUrl);

  if (!result.ok) {
    console.error(`distill connect: ${result.reason}`);
    return 1;
  }
  console.log(`distill: connected to ${result.apiUrl}`);
  console.log("         recent sessions will sync after each Claude Code session ends:");
  console.log("         session metadata and pipeline counts/durations only, never");
  console.log("         prompt content, tool inputs, or skill bodies.");
  console.log("         `distill sync` pushes now, `distill disconnect` unlinks,");
  console.log("         `distill telemetry off` keeps sync but silences pipeline counts.");
  return 0;
}

async function runDisconnect(): Promise<number> {
  if (disconnect()) {
    console.log("distill: disconnected from Plouto. Local skills and data are untouched.");
  } else {
    console.log("distill: not connected, nothing to do");
  }
  return 0;
}

async function runProbe(flags: Flags): Promise<number> {
  console.log("distill: scanning your recent sessions for a first skill (1-3 min)...");
  const result = await upskill({ force: true, probe: true, noTelemetry: flags.noTelemetry });
  const v = result.verdict;
  if (v && (v.verdict === "CREATE" || v.verdict === "UPDATE") && result.skillPath) {
    console.log("");
    console.log(`distill found one pattern in your last ${result.scanned} session(s):`);
    console.log("");
    console.log(`  ${v.name}`);
    console.log(`  -> ${result.skillPath}`);
    console.log("");
    console.log("It loads automatically in your next Claude Code session.");
    return 0;
  }
  console.log("");
  console.log("distill: no clear pattern in your recent sessions yet.");
  console.log("Background mining is on; your first skill arrives as you work.");
  return 0;
}

async function runStatus(flags: Flags): Promise<number> {
  const skills = listExistingSkills();
  const minedSkills = skills.filter((s) => s.frontmatter?.created_by === "distill");
  const untrackedSkills = skills.length - minedSkills.length;
  // same resolution upskill uses, so status agrees with placement
  // even when run from a subdirectory
  const projectRoot = findProjectRoot(process.cwd());
  const candidateCount =
    listCandidates().length +
    (projectRoot ? listCandidates(join(projectRoot, ".claude", "skill-candidates")).length : 0);

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
  const cfg = readConfig();
  const plouto = cfg.plouto
    ? { apiUrl: cfg.plouto.api_url, lastSyncedAt: cfg.plouto.last_synced_at }
    : null;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          mode: cfg.team ? "team" : "solo",
          storage: SKILLS_ROOT,
          skills: { mined: minedSkills.length, untracked: untrackedSkills, candidates: candidateCount },
          lastMine,
          identity,
          plouto,
          version: VERSION,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`distill ${VERSION}\n`);
  console.log(`Mode:        ${cfg.team ? "team" : "solo"} (local-first)`);
  console.log(`Storage:     ${SKILLS_ROOT}`);
  console.log(
    `Skills:      ${minedSkills.length} mined by distill, ${untrackedSkills} other, ${candidateCount} candidate(s) pending recurrence`,
  );
  console.log(`Last run:    ${lastMine ?? "never"}`);
  console.log(`Identity:    ${identity}`);
  if (plouto) {
    console.log(`Plouto:      connected (${plouto.apiUrl})`);
    console.log(`Last sync:   ${plouto.lastSyncedAt ?? "never"}`);
  } else {
    console.log(`Plouto:      not connected (distill connect)`);
  }
  return 0;
}

async function runHook(event: string, _flags: Flags): Promise<number> {
  // hooks must exit 0 no matter what, they can never break the agent
  try {
    switch (event) {
      case "counter": {
        const next = bumpCounter();
        if (next >= PROMPTS_THRESHOLD) {
          spawnUpskillDetached(await hookTranscriptPath());
          resetCounter();
        }
        return 0;
      }
      case "stop": {
        spawnUpskillDetached(await hookTranscriptPath());
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

// Claude Code pipes a JSON payload to hooks on stdin; transcript_path
// identifies the session that fired the hook. Without it the worker
// can never mine that session: mid-flight it is inside the
// active-session grace window, and even at Stop it was written
// seconds ago.
async function hookTranscriptPath(): Promise<string | null> {
  try {
    if (process.stdin.isTTY) return null; // invoked by hand, no payload
    const raw = await Bun.stdin.text();
    if (!raw) return null;
    const t = JSON.parse(raw)?.transcript_path;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

async function runInstall(flags: Flags): Promise<number> {
  if (flags.noTelemetry) {
    setTelemetryEnabled(false);
  }
  const binary = resolveSelfPath();
  const result = installPlugin({ distillBinaryPath: binary });
  console.log(`distill: installed Claude Code plugin`);
  console.log(`         plugin dir: ${result.pluginDir}`);
  console.log(`         hooks:      ${result.hooksFile}`);
  console.log(`         binary:     ${binary}`);
  const starters = installStarterSkills(await gitEmail());
  if (starters.length > 0) {
    console.log(`         starter skills: ${starters.join(", ")}`);
  }
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

function spawnUpskillDetached(transcriptPath?: string | null): void {
  const selfPath = resolveSelfPath();
  const args = [selfPath, "_upskill"];
  if (transcriptPath) args.push("--transcript", transcriptPath);
  try {
    const proc = Bun.spawn(args, {
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
  // compiled binary: execPath IS the binary (argv[0] is not reliable
  // in compiled bun). `bun src/cli.ts`: execPath is the bun runtime,
  // fall back to a PATH lookup.
  const exe = process.execPath ?? "";
  if (exe && !/[/\\]bun(-profile)?(\.exe)?$/.test(exe)) {
    return resolve(exe);
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
      console.error("usage: distill telemetry {status|on|off|reset-install-id|test}");
      return 2;
  }
}

function showTelemetryStatus(noTelemetryFlag: boolean): number {
  const cfg = readConfig();
  const decision = resolveTelemetry({ noTelemetryFlag });
  console.log(`telemetry:   ${cfg.telemetry.enabled ? "on" : "off"}`);
  console.log(`mode:        ${cfg.team ? "team" : "solo"}`);
  console.log(`endpoint:    ${decision.endpoint || "(none)"}`);
  console.log(`install-id:  ${cfg.telemetry.install_id}`);
  if (decision.emit) {
    console.log(`status:      emitting (${decision.reason})`);
  } else {
    console.log(`status:      not emitting (${decision.reason})`);
  }
  return 0;
}

async function runTelemetryTest(): Promise<number> {
  const decision = resolveTelemetry();
  if (!decision.emit) {
    console.log(`distill telemetry test: telemetry disabled (${decision.reason})`);
    return 0;
  }
  console.log(`distill telemetry test: POSTing a test record to ${decision.endpoint}...`);
  const payload = buildTestRecord();
  await emitLogs({ payload, decision });
  console.log("distill telemetry test: see ~/.distill/logs/upskill.log for the exporter's response.");
  return 0;
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

// exitCode instead of exit() so the in-flight telemetry POST can
// drain; the exporter's own timeout bounds how long that takes
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`distill: fatal: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
