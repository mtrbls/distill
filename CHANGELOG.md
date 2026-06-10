# Changelog

All notable changes to distill are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and distill adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (candidate skill tier)

- New skills are no longer created directly. A first occurrence of a
  pattern now writes a **candidate** — dormant, never loaded by
  Claude Code, costing nothing. When a later pass sees the pattern
  recur, the new `PROMOTE` verdict activates the candidate into the
  live skills directory with a body merged from both occurrences.
  This moves recurrence detection from "two occurrences inside one
  curator prompt" to "a match against a persistent ledger", which
  works across sessions, across days, and across teammates.
- Candidates from project work live in that project's
  `.claude/skill-candidates/` and travel through git like skills do:
  one teammate's sighting plus another's adds up to a promotion.
  Work outside any project uses `~/.distill/candidates/`.
- Candidates that never recur are archived (not deleted) to a
  sibling `…-archive/` directory after 45 days
  (`candidateExpiryDays`).
- A re-CREATE of an existing candidate name counts as a
  re-observation and merges into the candidate.
- `distill status` shows the pending-candidate count; `--json` gains
  `skills.candidates`. Upskill output distinguishes "new candidate"
  (dormant) from "promoted skill" (active).
- The install-time probe still creates a live skill directly: its
  purpose is a loadable skill minutes after install.

### Fixed (mining pipeline)

- **`distill init`** opts a project in: it writes a
  `.claude/distill.json` marker (commit it to cover the whole team).
  Placement anchors to the nearest ancestor carrying the marker, and
  nothing else — a bare `.claude/` dir is not consent, since Claude
  Code creates one for settings the moment anyone uses it. `$HOME` is
  a hard ceiling for the walk. Sessions started in subdirectories
  anchor correctly, a subproject's own marker is respected, and
  evidence spanning multiple projects places globally rather than
  into either project's git history.

- Hooks read Claude Code's stdin payload and pass `transcript_path`
  to the worker; the triggering session is exempt from the
  active-session grace window. Previously mid-session mining could
  never see the session that fired it, and even the Stop hook missed
  the session that had just ended.
- The curator (`claude -p`) runs from `~/.distill/curator/` and
  discovery skips that project dir, so the pipeline no longer mines
  its own curator transcripts. Usage and sync still count them — they
  are real token spend.
- Harvest feeds the curator real evidence: allowlisted tool inputs
  (Bash commands, Edit old/new strings, file paths, Grep patterns —
  field-by-field, never content blobs), tool results with the tail
  preserved when they look like errors, and a char budget that
  prioritizes correction turns and failure-adjacent pairs over
  routine traffic instead of pure recency.

### Changed (breaking)

- The `mine` subcommand is now `upskill`. `distill mine` returns an
  unknown-command error. The internal `_mine` worker is now `_upskill`.
  All hook scripts are updated automatically when you re-run
  `distill install`.
- `Last mine:` in `distill status` is now `Last run:`.
- **Anonymous telemetry is on by default.** distill sends phase
  counts, durations, and verdict enums to Plouto's OTEL endpoint.
  No prompt content, no skill bodies, no identity. Opt out with
  `distill telemetry off`, `DO_NOT_TRACK=1`, or `--no-telemetry`.
  See the README's Privacy section for the full data contract.

### Added

- `src/upskill/` directory replaces the monolithic `src/mine.ts`. The
  pipeline is now nine focused modules with an acyclic dependency
  graph: discover, harvest, prompt, curator, verdict, apply, state,
  types, index. The curator module is the only dirty boundary
  (subprocess); prompt and verdict are pure functions reusable by
  the v0.2 eval engine.
- The LLM decision step is named "curator" (it decides what enters
  your skill collection) and its verdicts are CREATE (new skill),
  UPDATE (extend an existing skill), SKIP (nothing new this round).
- Tagged file logger at `~/.distill/logs/upskill.log` traces every
  phase (`[discover] found 4 candidates`, `[curator] claude ok`, etc.).
  Best-effort, swallows its own errors, never blocks the agent.
- `state.json` now carries a `version: 1` field. Existing v0.1
  state files without `version` are read as v1 and migrated on the
  next write. No user action required.
- `UpskillResult` carries a `phase` field naming which phase produced
  the outcome (`discovery` | `extraction` | `curation` | `done`). Surfaces in `distill upskill --json` and unblocks the
  v0.2 eval engine.
- `src/upskill/config.ts` for persistent settings at
  `~/.distill/config.json` (telemetry on/off, endpoint override,
  install-id, first-run-notice state, mode).
- `src/upskill/telemetry.ts` hand-rolled OTLP/HTTP/JSON exporter.
  Fire-and-forget POST with 5s timeout, silent on failure (logs to
  the file logger instead). No npm deps.
- `src/upskill/payload.ts` mode-aware OTLP span builder. Solo
  enforces a strict Level-2 attribute allowlist at the emission
  boundary; team-only fields are scrubbed if mode is solo.
- `distill telemetry` subcommand (status/on/off/endpoint/reset-install-id/test).
- `--no-telemetry` global flag (place before or after the command).
- First-run notice shown once after the first `distill upskill` or
  `distill install`.
- Test suite (`bun test`, zero added dependencies): 41 tests covering
  verdict parsing, curator prompt construction, SKILL.md frontmatter
  round-trips, JSONL pair extraction, and the telemetry scrub
  allowlist. CI runs them on macOS and Linux.

### Added (team skills over git)

- `distill team init <git-url>` / `share <skill>` / `pull` / `leave`.
  Team skill sharing needs only a git repo; auth is the user's
  existing git credentials. The checkout lives in `~/.distill/team/`
  and skills materialize flat into `~/.claude/skills/` on pull
  (Claude Code's loader and the curator both see them). A manifest
  tracks team-owned names: repo updates overwrite them, repo
  deletions remove them, and a local skill that isn't team-owned is
  never overwritten on a name collision. The Stop-hook worker pulls
  automatically, so teammates' skills appear between sessions.
- Level-4 content capture is retired. The telemetry scrub allowlist
  now applies to every span unconditionally; team membership changes
  nothing about telemetry. The Plouto analytics tier (`distill
  connect`) stays metadata-only and per-user.

### Added (usage + Plouto sync)

- `distill usage`: local token + tool usage report from your session
  files. Tokens by model (input/output/cache read+write), top tools,
  MCP rollup, skills invoked. `--days N`, `--json`. Works offline.
- `distill connect` / `disconnect`: link the install to a Plouto
  workspace via browser sign-in (or `--token` for headless). Config
  file is chmod 600 once it holds a credential.
- `distill sync`: incremental push of session metadata to Plouto's
  existing `/api/ingest/sessions` endpoint. Watermark-based (recent
  sessions only, no bulk backfill), chunked under the server's 2 MB
  body cap, watermark advances only on success. Connected installs
  also sync automatically after each upskill pass (Stop hook).
- `src/upskill/usage.ts`: metadata extractor, a TypeScript port of
  Plouto's extractor whitelist. Tool names yes, tool inputs never;
  counts and enums, never content.

### Planned for 0.2.0

- Evals for skills: replay engine, drift detection, quality scoring.
  See `INDIVIDUAL.md` in the spec repo for the design.
- Onboarding probe: forced-CREATE first upskill at install time so
  the user sees a real skill within minutes of `curl ... | sh`.
- `distill enable` / `distill disable` (config flag flip).
- `distill upgrade` (self-update from GitHub Releases).

## [0.1.0] - 2026-06-09

### Added

- `distill mine` reads `~/.claude/projects/*.jsonl`, builds a
  curation prompt that includes existing skills in scope plus recent
  prompt / response pairs, runs the prompt through `claude -p`,
  parses the verdict, and writes SKILL.md accordingly.
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
