import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../log.ts";
import { CURATOR_CWD } from "./curator.ts";
import type { Watermark } from "./state.ts";
import type { Candidate, UpskillConfig } from "./types.ts";

const log = createLogger("discover");

// Claude Code encodes a session's project dir by replacing "/" and
// "." with "-". Exact match — a suffix would also catch a real
// project that happens to be named *distill-curator.
const CURATOR_DIR_ENCODED = CURATOR_CWD.replace(/[/.]/g, "-");

export function findCandidates(args: {
  sessionsRoot: string;
  // ~/.codex/sessions — date-sharded rollout-*.jsonl; optional so
  // machines without Codex skip the walk entirely
  codexSessionsRoot?: string;
  watermark: Watermark;
  config: UpskillConfig;
  force: boolean;
  // the session whose hook spawned this run: exempt from the
  // active-session grace, else mid-session mining can never see the
  // very session that triggered it (it is being written to right now)
  triggerPath?: string;
}): Candidate[] {
  const { sessionsRoot, codexSessionsRoot, watermark, config, force, triggerPath } = args;

  const threshold = !force && watermark.lastDate ? Date.parse(watermark.lastDate) : 0;
  const activeGrace = Date.now() - config.activeSessionGraceMs;
  const eligible = (p: string, mtimeMs: number): boolean => {
    const isTrigger = p === triggerPath;
    if (!isTrigger && mtimeMs > activeGrace) return false;
    if (!isTrigger && mtimeMs <= threshold) return false;
    return true;
  };

  const candidates: Candidate[] = [];

  if (existsSync(sessionsRoot)) {
    for (const projectDir of readdirSync(sessionsRoot)) {
      // curator transcripts (claude -p spawned from ~/.distill/curator)
      // are distill's own exhaust, never evidence
      if (projectDir === CURATOR_DIR_ENCODED) continue;
      const full = join(sessionsRoot, projectDir);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      let entries: string[];
      try {
        entries = readdirSync(full);
      } catch {
        continue;
      }
      for (const file of entries) {
        if (!file.endsWith(".jsonl")) continue;
        const p = join(full, file);
        let fs;
        try {
          fs = statSync(p);
        } catch {
          continue;
        }
        if (!eligible(p, fs.mtimeMs)) continue;
        candidates.push({
          path: p,
          dir: projectDir,
          sessionUuid: file.replace(/\.jsonl$/, ""),
          project: deriveProjectName(projectDir),
          mtimeMs: fs.mtimeMs,
          provider: "claude",
        });
      }
    }
  } else {
    log(`sessions root missing: ${sessionsRoot}`);
  }

  if (codexSessionsRoot && existsSync(codexSessionsRoot)) {
    for (const p of walkJsonl(codexSessionsRoot, 3)) {
      let fs;
      try {
        fs = statSync(p);
      } catch {
        continue;
      }
      if (!eligible(p, fs.mtimeMs)) continue;
      // grouping key comes from the session's own cwd (line 1 of the
      // rollout); "codex:" prefix keeps it from ever colliding with a
      // Claude encoded dir, so passes stay provider-pure
      const cwd = codexHeadCwd(p);
      if (!cwd) continue;
      candidates.push({
        path: p,
        dir: `codex:${cwd}`,
        sessionUuid: basename(p).replace(/\.jsonl$/, ""),
        project: cwd.replace(/^.*\/(?=[^/]+\/[^/]+$)/, ""),
        mtimeMs: fs.mtimeMs,
        provider: "codex",
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, config.sessionsToMine);
  log(`found ${candidates.length} eligible, kept top ${top.length}`);
  return top;
}

// Codex shards sessions as <root>/YYYY/MM/DD/rollout-*.jsonl
function walkJsonl(dir: string, depth: number): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory() && depth > 0) out.push(...walkJsonl(p, depth - 1));
    else if (s.isFile() && e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function listCodexSessionFiles(root: string, sinceMs: number): string[] {
  return walkJsonl(root, 3).filter((p) => {
    try {
      return statSync(p).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

// Codex's notify payload carries no transcript path; at
// agent-turn-complete the newest rollout is the triggering session
export function newestCodexSession(root: string): string | null {
  let best: { p: string; m: number } | null = null;
  for (const p of walkJsonl(root, 3)) {
    try {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    } catch {}
  }
  return best?.p ?? null;
}

// first line of a rollout is session_meta carrying the cwd. It also
// carries the full base_instructions blob, so the line can run to
// hundreds of KB — read chunks until the first newline, not a fixed
// slice
function codexHeadCwd(jsonlPath: string): string | null {
  const CHUNK = 65_536;
  const MAX = 4 * 1024 * 1024;
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      let head = "";
      let pos = 0;
      const buf = Buffer.alloc(CHUNK);
      while (pos < MAX) {
        const n = readSync(fd, buf, 0, CHUNK, pos);
        if (n <= 0) break;
        head += buf.toString("utf-8", 0, n);
        pos += n;
        if (head.includes("\n")) break;
      }
      const firstLine = head.split("\n")[0] ?? "";
      const obj = JSON.parse(firstLine);
      const cwd = obj?.payload?.cwd;
      return typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function deriveProjectName(rawDir: string): string {
  // ~/.claude/projects/-Users-alice-w-myproj -> "w/myproj"
  return rawDir.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/") || rawDir;
}
