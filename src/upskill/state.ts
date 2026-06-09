import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import type { Candidate } from "./types.ts";

const log = createLogger("state");

const DISTILL_HOME = join(homedir(), ".distill");
const STATE_PATH = join(DISTILL_HOME, "state.json");

const CURRENT_VERSION = 1;

export interface Watermark {
  version: number;
  lastDate: string | null;
  lastSessionUuid: string | null;
}

const EMPTY: Watermark = {
  version: CURRENT_VERSION,
  lastDate: null,
  lastSessionUuid: null,
};

export function readWatermark(): Watermark {
  if (!existsSync(STATE_PATH)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<Watermark>;
    return {
      version: typeof raw.version === "number" ? raw.version : CURRENT_VERSION,
      lastDate: raw.lastDate ?? null,
      lastSessionUuid: raw.lastSessionUuid ?? null,
    };
  } catch (e) {
    log(`failed to read ${STATE_PATH}: ${(e as Error).message}`);
    return EMPTY;
  }
}

export function writeWatermark(w: Watermark): void {
  try {
    mkdirSync(DISTILL_HOME, { recursive: true });
    writeFileSync(
      STATE_PATH,
      JSON.stringify({ ...w, version: CURRENT_VERSION }, null, 2) + "\n",
    );
  } catch (e) {
    log(`failed to write ${STATE_PATH}: ${(e as Error).message}`);
  }
}

export function advanceWatermark(candidates: Candidate[]): void {
  if (candidates.length === 0) return;
  const newest = candidates[0]!;
  writeWatermark({
    version: CURRENT_VERSION,
    lastDate: new Date(newest.mtimeMs).toISOString(),
    lastSessionUuid: newest.sessionUuid,
  });
  log(`watermark advanced to ${new Date(newest.mtimeMs).toISOString()}`);
}
