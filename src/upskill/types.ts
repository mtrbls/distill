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

// CREATE = new candidate (dormant until the pattern recurs),
// PROMOTE = a candidate's pattern recurred, activate it,
// UPDATE = extend an active skill, SKIP = nothing worth saving
export interface Verdict {
  verdict: "CREATE" | "UPDATE" | "PROMOTE" | "SKIP";
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
  | "done";

export interface UpskillConfig {
  sessionsToMine: number;
  maxMsgPerSession: number;
  maxPromptChars: number;
  curatorTimeoutMs: number;
  // model alias or full name passed to `claude -p --model`. Curation
  // is judge-and-emit-JSON; it does not need the user's interactive
  // default model.
  curatorModel: string;
  activeSessionGraceMs: number;
  candidateExpiryDays: number;
}

export const DEFAULT_CONFIG: UpskillConfig = {
  sessionsToMine: 5,
  maxMsgPerSession: 60,
  maxPromptChars: 60_000,
  curatorTimeoutMs: 240_000,
  curatorModel: "sonnet",
  activeSessionGraceMs: 30_000,
  candidateExpiryDays: 45,
};

export interface UpskillOptions {
  sessionsRoot?: string;
  skillsRoot?: string;
  candidatesRoot?: string;
  config?: Partial<UpskillConfig>;
  force?: boolean;
  author?: string;
  noTelemetry?: boolean;
  probe?: boolean;
  // transcript of the session whose hook spawned this run; exempt
  // from the active-session grace so it can be mined as-of-now
  triggerTranscript?: string;
}

export interface UpskillResult {
  phase: Phase;
  scanned: number;
  pairs: number;
  verdict: Verdict | null;
  skillPath: string | null;
  // candidate = written dormant, active = loaded by Claude Code
  tier?: "candidate" | "active";
  reason: string;
  dirs?: string[];
}
