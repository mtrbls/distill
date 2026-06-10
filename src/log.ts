import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGS_DIR = join(homedir(), ".distill", "logs");
const LOG_FILE = join(LOGS_DIR, "upskill.log");

let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) return;
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // never let logging break anything
  }
}

export type Logger = (msg: string) => void;

export function createLogger(tag: string): Logger {
  return (msg: string): void => {
    ensureDir();
    try {
      const ts = new Date().toISOString();
      appendFileSync(LOG_FILE, `${ts} [${tag}] ${msg}\n`);
    } catch {
      // best effort
    }
  };
}
