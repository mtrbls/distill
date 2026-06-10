import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../log.ts";
import { listExistingSkills, mergeSkill, writeNewSkill } from "../skill.ts";
import type { Candidate, Verdict } from "./types.ts";

const log = createLogger("apply");

export interface ApplyResult {
  skillPath: string | null;
  // candidate = dormant in candidatesRoot, active = loaded by Claude Code
  tier?: "candidate" | "active";
  ok: boolean;
  reason: string;
}

export function applyVerdict(args: {
  verdict: Verdict;
  candidates: Candidate[];
  skillsRoot: string;
  candidatesRoot: string;
  author: string;
  probe?: boolean;
}): ApplyResult {
  const { verdict, candidates, skillsRoot, candidatesRoot, author } = args;

  if (verdict.verdict === "SKIP") {
    log(`SKIP: ${verdict.reason ?? "no reason given"}`);
    return { skillPath: null, ok: true, reason: verdict.reason ?? "skip" };
  }

  const fail = (reason: string): ApplyResult => {
    log(reason);
    return { skillPath: null, ok: false, reason };
  };

  if (!verdict.name || !verdict.body) {
    return fail(`${verdict.verdict} verdict missing name or body`);
  }

  // resolve the per-verdict differences, then upsert once
  let root: string;
  let tier: "candidate" | "active";
  let description = verdict.description ?? undefined;
  let trigger = verdict.trigger ?? undefined;
  let writeAuthor = author;
  let sourceProjects = [...new Set(candidates.map((c) => c.dir ?? "").filter(Boolean))];
  let promotedFrom: string | null = null;

  switch (verdict.verdict) {
    case "CREATE":
      // probe is the one forced-create path that goes live directly:
      // its whole point is a loadable skill minutes after install
      tier = args.probe ? "active" : "candidate";
      root = tier === "active" ? skillsRoot : candidatesRoot;
      break;
    case "PROMOTE": {
      const candidate = listExistingSkills(candidatesRoot).find((c) => c.name === verdict.name);
      if (!candidate) {
        return fail(`PROMOTE target '${verdict.name}' is not a candidate`);
      }
      tier = "active";
      root = skillsRoot;
      description ??= candidate.frontmatter?.description;
      trigger ??= candidate.frontmatter?.trigger;
      writeAuthor = candidate.frontmatter?.author ?? author;
      sourceProjects = [
        ...new Set([...(candidate.frontmatter?.source_projects ?? []), ...sourceProjects]),
      ];
      promotedFrom = join(candidatesRoot, verdict.name);
      break;
    }
    case "UPDATE":
      tier = "active";
      root = skillsRoot;
      break;
  }

  try {
    const exists = existsSync(join(root, verdict.name, "SKILL.md"));
    if (!exists && !description) {
      return fail(`${verdict.verdict} '${verdict.name}' would create a skill but has no description`);
    }
    const r = exists
      ? mergeSkill({
          skillsRoot: root,
          name: verdict.name,
          description,
          trigger,
          body: verdict.body,
          newSourceProjects: sourceProjects,
          editor: author,
        })
      : writeNewSkill({
          skillsRoot: root,
          name: verdict.name,
          description: description!,
          trigger,
          body: verdict.body,
          sourceProjects,
          author: writeAuthor,
        });
    if (promotedFrom) {
      try {
        rmSync(promotedFrom, { recursive: true, force: true });
      } catch (e) {
        log(`promoted but failed to remove candidate dir: ${(e as Error).message}`);
      }
    }
    log(`${verdict.verdict} ${verdict.name} v${r.version} (${tier}) -> ${r.path}`);
    return { skillPath: r.path, tier, ok: true, reason: verdict.reason ?? "" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return fail(`${verdict.verdict} failed: ${msg.slice(0, 200)}`);
  }
}

export function gitEmailFallback(): string {
  try {
    const proc = Bun.spawnSync(["git", "config", "user.email"]);
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) return out;
  } catch {
    // ignore
  }
  return "unknown@local";
}
