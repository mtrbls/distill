import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import type { Watermark } from "./state.ts";
import type { Candidate, UpskillConfig } from "./types.ts";

const log = createLogger("discover");

export function findCandidates(args: {
  sessionsRoot: string;
  watermark: Watermark;
  config: UpskillConfig;
  force: boolean;
}): Candidate[] {
  const { sessionsRoot, watermark, config, force } = args;

  if (!existsSync(sessionsRoot)) {
    log(`sessions root missing: ${sessionsRoot}`);
    return [];
  }

  const threshold = !force && watermark.lastDate ? Date.parse(watermark.lastDate) : 0;
  const activeGrace = Date.now() - config.activeSessionGraceMs;

  const candidates: Candidate[] = [];
  for (const projectDir of readdirSync(sessionsRoot)) {
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
      if (fs.mtimeMs > activeGrace) continue;
      if (fs.mtimeMs <= threshold) continue;
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
