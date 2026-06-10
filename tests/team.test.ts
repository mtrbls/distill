import { describe, expect, test } from "bun:test";
import { deriveTeamName } from "../src/upskill/team.ts";

// teamInit/share/pull mutate ~/.distill and ~/.claude/skills through
// module-level paths, so the round-trip lives in the manual e2e
// (see TEAM.md verification); unit coverage here sticks to the pure
// parts.

describe("deriveTeamName", () => {
  test("derives from ssh urls", () => {
    expect(deriveTeamName("git@github.com:org/skills.git")).toBe("skills");
    expect(deriveTeamName("git@github.com:org/Team-Skills.git")).toBe("team-skills");
  });

  test("derives from https urls", () => {
    expect(deriveTeamName("https://github.com/org/claude-skills.git")).toBe("claude-skills");
    expect(deriveTeamName("https://github.com/org/claude-skills")).toBe("claude-skills");
  });

  test("tolerates trailing slashes", () => {
    expect(deriveTeamName("https://github.com/org/skills/")).toBe("skills");
  });

  test("rejects names that would be unsafe directory names", () => {
    expect(deriveTeamName("")).toBeNull();
    expect(deriveTeamName("git@github.com:org/..git")).toBeNull();
  });
});
