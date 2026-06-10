// Shells out to `claude -p`. The only subprocess in the pipeline,
// everything else is pure data transformation.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import type { UpskillConfig } from "./types.ts";

const log = createLogger("curator");

// claude -p is itself a Claude Code session and writes a transcript
// under ~/.claude/projects/<encoded-cwd>/. Pin the cwd so curator
// transcripts land in one quarantined project dir that discovery
// skips — otherwise the next pass mines the curator's own output and
// the pipeline reviews its own exhaust.
export const CURATOR_CWD = join(homedir(), ".distill", "curator");

export interface CuratorResult {
  stdout: string;
  error: string | null;
}

export async function runCurator(args: {
  prompt: string;
  config: UpskillConfig;
}): Promise<CuratorResult> {
  log(`spawning claude -p (timeout ${args.config.curatorTimeoutMs}ms)`);

  mkdirSync(CURATOR_CWD, { recursive: true });
  // prompt goes over stdin: as an argv arg it would be visible to every
  // local process via `ps`, and it carries session content
  const proc = Bun.spawn(["claude", "-p"], {
    cwd: CURATOR_CWD,
    stdin: new TextEncoder().encode(args.prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, args.config.curatorTimeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      log(`claude exited ${code}`);
      return {
        stdout: stdout || "",
        error: stderr || `claude exited ${code}`,
      };
    }
    log(`claude ok, ${stdout.length} chars`);
    return { stdout, error: null };
  } finally {
    clearTimeout(timeout);
  }
}
