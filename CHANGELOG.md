# Changelog

All notable changes to distill are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and distill adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (breaking)

- The `mine` subcommand is now `upskill`. `distill mine` returns an
  unknown-command error. The internal `_mine` worker is now `_upskill`.
  All hook scripts are updated automatically when you re-run
  `distill install`.
- `Last mine:` in `distill status` is now `Last run:`.

### Added

- `src/upskill/` directory replaces the monolithic `src/mine.ts`. The
  pipeline is now seven focused modules with an acyclic dependency
  graph: discover, harvest, judge, apply, state, types, index.
- Tagged file logger at `~/.distill/logs/upskill.log` traces every
  phase (`[discover] found 4 candidates`, `[judge] claude ok`, etc.).
  Best-effort, swallows its own errors, never blocks the agent.
- `state.json` now carries a `version: 1` field. Existing v0.1
  state files without `version` are read as v1 and migrated on the
  next write. No user action required.
- `UpskillResult` carries a `phase` field naming which phase produced
  the outcome (`discovery` | `extraction` | `judging` | `applying` |
  `done`). Surfaces in `distill upskill --json` and unblocks the
  v0.2 eval engine.

### Planned for 0.2.0

- Evals for skills: replay engine, drift detection, quality scoring.
  See `INDIVIDUAL.md` in the spec repo for the design.
- Onboarding probe: forced-KEEP first upskill at install time so the
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
