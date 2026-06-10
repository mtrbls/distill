import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  watermark: Watermark;
  config: UpskillConfig;
  force: boolean;
  // the session whose hook spawned this run: exempt from the
  // active-session grace, else mid-session mining can never see the
  // very session that triggered it (it is being written to right now)
  triggerPath?: string;
}): Candidate[] {
  const { sessionsRoot, watermark, config, force, triggerPath } = args;

  if (!existsSync(sessionsRoot)) {
    log(`sessions root missing: ${sessionsRoot}`);
    return [];
  }

  const threshold = !force && watermark.lastDate ? Date.parse(watermark.lastDate) : 0;
  const activeGrace = Date.now() - config.activeSessionGraceMs;

  const candidates: Candidate[] = [];
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
      const isTrigger = p === triggerPath;
      if (!isTrigger && fs.mtimeMs > activeGrace) continue;
      if (!isTrigger && fs.mtimeMs <= threshold) continue;
      const sessionUuid = file.replace(/\.jsonl$/, "");
      candidates.push({
        path: p,
        dir: projectDir,
        sessionUuid,
        project: deriveProjectName(projectDir),
        mtimeMs: fs.mtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, config.sessionsToMine);
  log(`found ${candidates.length} eligible, kept top ${top.length}`);
  return top;
}

function deriveProjectName(rawDir: string): string {
  // ~/.claude/projects/-Users-alice-w-myproj -> "w/myproj"
  return rawDir.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/") || rawDir;
}
