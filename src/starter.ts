// Starter skills shipped with distill. Written at install only when
// the name doesn't already exist; never overwritten, never removed.
// Generic by design: patterns that hold on any codebase.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_ROOT, writeNewSkill } from "./skill.ts";

const STARTERS: { name: string; description: string; trigger: string; body: string }[] = [
  {
    name: "verify-targets-before-bulk-change",
    description:
      "Verify external destinations (API slugs, event names, IDs, endpoints) actually exist before changing every reference to them",
    trigger:
      "About to update an identifier from a third-party service across multiple files",
    body: `## When to use
Before sweeping changes that point code at an external destination: calendar slugs, analytics event names, webhook paths, product IDs.

## Workflow
1. Confirm the destination exists in the external service first
2. Make the change everywhere
3. Spot-check one instance end-to-end after shipping

## Anti-patterns
- Trusting that a provided slug or ID exists because it was mentioned
- Updating all references and hoping
- Skipping the post-change spot check`,
  },
  {
    name: "run-it-before-claiming-done",
    description:
      "Run the code, test, or page that changed and observe the behavior before reporting a task as complete",
    trigger: "About to tell the user a change works or a task is finished",
    body: `## When to use
Any time a change is about to be described as done, fixed, or working.

## Workflow
1. Execute the changed path: run the test, start the server, load the page, call the endpoint
2. Observe actual output, not expected output
3. Report what was observed, including failures, verbatim

## Anti-patterns
- "This should work now" without having run it
- Claiming tests pass without running them
- Describing the intended behavior as the observed behavior`,
  },
];

export function installStarterSkills(author: string): string[] {
  const written: string[] = [];
  for (const s of STARTERS) {
    if (existsSync(join(SKILLS_ROOT, s.name, "SKILL.md"))) continue;
    try {
      writeNewSkill({
        name: s.name,
        description: s.description,
        trigger: s.trigger,
        body: s.body,
        sourceSessions: [],
        author,
      });
      written.push(s.name);
    } catch {
      // never block install on a starter skill
    }
  }
  return written;
}
