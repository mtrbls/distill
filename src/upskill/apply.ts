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
  const sourceProjects = [...new Set(candidates.map((c) => c.dir ?? "").filter(Boolean))];

  if (verdict.verdict === "SKIP") {
    log(`SKIP: ${verdict.reason ?? "no reason given"}`);
    return { skillPath: null, ok: true, reason: verdict.reason ?? "skip" };
  }

  if (verdict.verdict === "CREATE") {
    if (!verdict.name || !verdict.body || !verdict.description) {
      log(`CREATE verdict missing required field(s)`);
      return {
        skillPath: null,
        ok: false,
        reason: "CREATE verdict missing name, description, or body",
      };
    }
    // probe is the one forced-create path that goes live directly: its
    // whole point is a loadable skill minutes after install
    const tier = args.probe ? "active" as const : "candidate" as const;
    const root = tier === "active" ? skillsRoot : candidatesRoot;
    try {
      const r = writeNewSkill({
        skillsRoot: root,
        name: verdict.name,
        description: verdict.description,
        trigger: verdict.trigger ?? undefined,
        body: verdict.body,
        sourceProjects,
        author,
      });
      log(`wrote new ${tier} skill ${verdict.name} -> ${r.path}`);
      return { skillPath: r.path, tier, ok: true, reason: verdict.reason ?? "" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // a re-CREATE of an existing candidate is a re-observation; fold
      // the new evidence in rather than failing
      if (tier === "candidate" && /already exists/i.test(msg)) {
        try {
          const r = mergeSkill({
            skillsRoot: root,
            name: verdict.name,
            description: verdict.description,
            trigger: verdict.trigger ?? undefined,
            body: verdict.body,
            newSourceProjects: sourceProjects,
            editor: author,
          });
          log(`re-observed candidate ${verdict.name} v${r.version} -> ${r.path}`);
          return { skillPath: r.path, tier, ok: true, reason: verdict.reason ?? "" };
        } catch (e2: any) {
          const msg2 = String(e2?.message ?? e2);
          log(`candidate merge failed: ${msg2}`);
          return { skillPath: null, ok: false, reason: `candidate merge failed: ${msg2.slice(0, 200)}` };
        }
      }
      log(`writeNewSkill failed: ${msg}`);
      return {
        skillPath: null,
        ok: false,
        reason: `writeNewSkill failed: ${msg.slice(0, 200)}`,
      };
    }
  }

  if (verdict.verdict === "PROMOTE") {
    if (!verdict.name || !verdict.body) {
      log(`PROMOTE verdict missing required field(s)`);
      return {
        skillPath: null,
        ok: false,
        reason: "PROMOTE verdict missing name or body",
      };
    }
    const candidate = listExistingSkills(candidatesRoot).find((c) => c.name === verdict.name);
    if (!candidate) {
      log(`PROMOTE target ${verdict.name} not found in ${candidatesRoot}`);
      return {
        skillPath: null,
        ok: false,
        reason: `PROMOTE target '${verdict.name}' is not a candidate`,
      };
    }
    const description = verdict.description ?? candidate.frontmatter?.description;
    if (!description) {
      return {
        skillPath: null,
        ok: false,
        reason: "PROMOTE has no description (verdict and candidate both lack one)",
      };
    }
    const mergedProjects = [
      ...new Set([...(candidate.frontmatter?.source_projects ?? []), ...sourceProjects]),
    ];
    try {
      const r = existsSync(join(skillsRoot, verdict.name, "SKILL.md"))
        ? mergeSkill({
            skillsRoot,
            name: verdict.name,
            description,
            trigger: verdict.trigger ?? candidate.frontmatter?.trigger,
            body: verdict.body,
            newSourceProjects: mergedProjects,
            editor: author,
          })
        : writeNewSkill({
            skillsRoot,
            name: verdict.name,
            description,
            trigger: verdict.trigger ?? candidate.frontmatter?.trigger,
            body: verdict.body,
            sourceProjects: mergedProjects,
            author: candidate.frontmatter?.author ?? author,
          });
      try {
        rmSync(join(candidatesRoot, verdict.name), { recursive: true, force: true });
      } catch (e) {
        log(`promoted but failed to remove candidate dir: ${(e as Error).message}`);
      }
      log(`promoted ${verdict.name} -> ${r.path}`);
      return { skillPath: r.path, tier: "active", ok: true, reason: verdict.reason ?? "" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      log(`promote failed: ${msg}`);
      return {
        skillPath: null,
        ok: false,
        reason: `promote failed: ${msg.slice(0, 200)}`,
      };
    }
  }

  // UPDATE
  if (!verdict.name || !verdict.body) {
    log(`UPDATE verdict missing required field(s)`);
    return {
      skillPath: null,
      ok: false,
      reason: "UPDATE verdict missing name or body",
    };
  }
  try {
    const r = mergeSkill({
      skillsRoot,
      name: verdict.name,
      description: verdict.description ?? undefined,
      trigger: verdict.trigger ?? undefined,
      body: verdict.body,
      newSourceProjects: sourceProjects,
      editor: author,
    });
    log(`merged into ${verdict.name} v${r.version} -> ${r.path}`);
    return { skillPath: r.path, tier: "active", ok: true, reason: verdict.reason ?? "" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/does not exist/i.test(msg) && verdict.description) {
      log(`UPDATE target ${verdict.name} missing, falling back to writeNewSkill`);
      try {
        const r = writeNewSkill({
          skillsRoot,
          name: verdict.name,
          description: verdict.description,
          trigger: verdict.trigger ?? undefined,
          body: verdict.body,
          sourceProjects,
          author,
        });
        log(`wrote new skill (update fallback) ${verdict.name} -> ${r.path}`);
        return { skillPath: r.path, tier: "active", ok: true, reason: verdict.reason ?? "" };
      } catch (e2: any) {
        const msg2 = String(e2?.message ?? e2);
        log(`writeNewSkill fallback failed: ${msg2}`);
        return {
          skillPath: null,
          ok: false,
          reason: `writeNewSkill fallback failed: ${msg2.slice(0, 200)}`,
        };
      }
    }
    log(`mergeSkill failed: ${msg}`);
    return {
      skillPath: null,
      ok: false,
      reason: `mergeSkill failed: ${msg.slice(0, 200)}`,
    };
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
