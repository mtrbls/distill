// The judge itself.
//
// The ONLY dirty boundary in the upskill pipeline: this is where we
// shell out to `claude -p` and wait for the LLM. Everything else is
// pure data transformation.
//
// Reused at v0.2 by the eval engine to invoke `claude -p` against
// synthetic replay prompts (and, if/when we add a second LLM backend,
// this is the abstraction layer that picks one).

import { createLogger } from "../log.ts";
import type { UpskillConfig } from "./types.ts";

const log = createLogger("judge");

export interface JudgeResult {
  stdout: string;
  error: string | null;
}

export async function runJudge(args: {
  prompt: string;
  config: UpskillConfig;
}): Promise<JudgeResult> {
  log(`spawning claude -p (timeout ${args.config.judgeTimeoutMs}ms)`);

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
  }, args.config.judgeTimeoutMs);

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
