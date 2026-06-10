import { createLogger } from "../log.ts";
import { mergeSkill, writeNewSkill } from "../skill.ts";
import type { Candidate, Verdict } from "./types.ts";

const log = createLogger("apply");

export interface ApplyResult {
  skillPath: string | null;
  ok: boolean;
  reason: string;
}

export function applyVerdict(args: {
  verdict: Verdict;
  candidates: Candidate[];
  skillsRoot: string;
  author: string;
}): ApplyResult {
  const { verdict, candidates, skillsRoot, author } = args;
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
      log(`wrote new skill ${verdict.name} -> ${r.path}`);
      return { skillPath: r.path, ok: true, reason: verdict.reason ?? "" };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      log(`writeNewSkill failed: ${msg}`);
      return {
        skillPath: null,
        ok: false,
        reason: `writeNewSkill failed: ${msg.slice(0, 200)}`,
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
    return { skillPath: r.path, ok: true, reason: verdict.reason ?? "" };
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
          sourceSessions,
          author,
        });
        log(`wrote new skill (update fallback) ${verdict.name} -> ${r.path}`);
        return { skillPath: r.path, ok: true, reason: verdict.reason ?? "" };
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
