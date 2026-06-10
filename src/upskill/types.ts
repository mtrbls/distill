// Shared types for the upskill pipeline.
//
// The orchestrator in index.ts depends on every other module.
// Every other module depends only on this file (plus stdlib).
// That is what keeps the dependency graph acyclic and what makes
// each module testable in isolation in v0.2 when evals land.

export interface Candidate {
  path: string;
  sessionUuid: string;
  project: string;
  mtimeMs: number;
}

export interface Pair {
  user: string;
  assistant: string;
}

// The curator's decision for one upskill run:
//   CREATE  write a brand-new skill
//   UPDATE  extend an existing skill with new evidence
//   SKIP    nothing new this round, no file written
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
}

export interface UpskillResult {
  phase: Phase;
  scanned: number;
  pairs: number;
  verdict: Verdict | null;
  skillPath: string | null;
  reason: string;
}
