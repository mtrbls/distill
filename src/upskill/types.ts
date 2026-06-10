// Shared types. Modules depend on this file and nothing else in the
// pipeline, which keeps the graph acyclic.

export interface Candidate {
  path: string;
  dir?: string;
  sessionUuid: string;
  project: string;
  mtimeMs: number;
}

export interface Pair {
  user: string;
  assistant: string;
}

// CREATE = new skill, UPDATE = extend an existing one, SKIP = nothing
// worth saving this round
export interface Verdict {
  verdict: "CREATE" | "UPDATE" | "SKIP";
  name: string | null;
  description: string | null;
  trigger: string | null;
  body: string | null;
  reason: string | null;
}

export type Phase =
  | "discovery"
  | "extraction"
  | "curation"
  | "applying"
  | "done";

export interface UpskillConfig {
  sessionsToMine: number;
  maxMsgPerSession: number;
  maxPromptChars: number;
  curatorTimeoutMs: number;
  activeSessionGraceMs: number;
}

export const DEFAULT_CONFIG: UpskillConfig = {
  sessionsToMine: 5,
  maxMsgPerSession: 60,
  maxPromptChars: 60_000,
  curatorTimeoutMs: 240_000,
  activeSessionGraceMs: 30_000,
};

export interface UpskillOptions {
  sessionsRoot?: string;
  skillsRoot?: string;
  config?: Partial<UpskillConfig>;
  force?: boolean;
  author?: string;
  noTelemetry?: boolean;
  probe?: boolean;
}

export interface UpskillResult {
  phase: Phase;
  scanned: number;
  pairs: number;
  verdict: Verdict | null;
  skillPath: string | null;
  reason: string;
  dirs?: string[];
}
