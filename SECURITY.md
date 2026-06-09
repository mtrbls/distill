# Security policy

distill runs locally on your machine and reads your Claude Code session
files. It does not phone home, does not call any network API in solo
mode, and has no cloud component.

## Reporting a vulnerability

If you find a security issue, please do not open a public GitHub
issue. Email instead:

  **security@plouto.ai**

Include:

- A short description of the issue
- Steps to reproduce
- Affected version (`distill --version`)
- Any relevant logs from `~/.distill/logs/`

You should expect an acknowledgement within 72 hours. Fix turnaround
depends on severity; critical issues are addressed within 7 days.

## Scope

In scope:

- Code execution vulnerabilities in the binary
- Plugin registration tampering (writing outside expected paths)
- Prompt injection vectors in the LLM judge that lead to local file
  damage or arbitrary command execution
- Unintended data exfiltration from solo mode (there should be none)
- SKILL.md parser issues that lead to denial of service or unexpected
  behavior

Out of scope:

- Claude Code itself, or other plugins (report to Anthropic /
  respective maintainers)
- The user's own session content (anything in your JSONL files is
  yours to manage)

## Privacy notes

distill reads `~/.claude/projects/*.jsonl` and `~/.claude/skills/`. It
writes to `~/.distill/` and `~/.claude/skills/`. It invokes the
`claude` CLI as a subprocess. Nothing else is read or written. If you
observe distill touching files outside these locations, that is itself
a security issue worth reporting.
