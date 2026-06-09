# Changelog

All notable changes to distill are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and distill adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for 0.2.0

- Evals for skills: replay engine, drift detection, quality scoring.
  See `INDIVIDUAL.md` in the spec repo for the design.
- Onboarding probe: forced-KEEP first mine at install time so the
  user sees a real skill within minutes of `curl ... | sh`.
- `distill enable` / `distill disable` (config flag flip).
- `distill upgrade` (self-update from GitHub Releases).

## [0.1.0] - 2026-06-09

### Added

- `distill mine` reads `~/.claude/projects/*.jsonl`, builds a judge
  prompt that includes existing skills in scope plus recent prompt /
  response pairs, runs the prompt through `claude -p`, parses a
  KEEP / MERGE / SKIP verdict, and writes SKILL.md accordingly.
- `distill status` shows mode, storage location, skill counts (mined
  vs other), last mine timestamp, and `git config user.email` identity.
- `distill install` registers the Claude Code plugin manifest and
  hooks, updates `installed_plugins.json` / `known_marketplaces.json`
  / `settings.json`. Idempotent.
- `distill uninstall` reverses `install`. Preserves skills.
- `distill hook counter` and `distill hook stop` for Claude Code's
  PostToolUse and Stop hooks. Both async, never block the agent,
  always exit 0.
- `distill _mine` internal entrypoint for detached background mining
  spawned by the hooks.
- Watermark at `~/.distill/state.json` ensures incremental mining
  (only sessions newer than the last successful mine are considered).
- Per-machine counter at `~/.distill/counter.json` for the
  intra-session threshold (default 30 tool calls).
- POSIX `install.sh` for `curl ... | sh` install. Detects platform,
  downloads from GitHub Releases, verifies SHA256 if a SHA256SUMS
  asset exists, places binary at `~/.distill/bin/distill`, runs
  `distill install` to register the Claude Code plugin.
- Single self-contained binary via `bun build --compile`. No Node,
  no npm, no `node_modules` at install or runtime.

[Unreleased]: https://github.com/mtrbls/distill/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mtrbls/distill/releases/tag/v0.1.0
