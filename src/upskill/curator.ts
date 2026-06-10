// Shells out to `claude -p`. The only subprocess in the pipeline,
// everything else is pure data transformation.

import { createLogger } from "../log.ts";
import type { UpskillConfig } from "./types.ts";

const log = createLogger("curator");

export interface CuratorResult {
  stdout: string;
  error: string | null;
}

export async function runCurator(args: {
  prompt: string;
  config: UpskillConfig;
}): Promise<CuratorResult> {
  log(`spawning claude -p (timeout ${args.config.curatorTimeoutMs}ms)`);

  const proc = Bun.spawn(["claude", "-p", args.prompt], {
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
