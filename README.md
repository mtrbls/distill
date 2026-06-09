# distill

Mine reusable skills from your Claude Code sessions.

One curl command. One self-contained binary. No npm, no Node, no cloud,
no telemetry, no signup.

```sh
curl -fsSL https://distill.plouto.ai/install.sh | sh
```

## What it does

distill reads your local Claude Code session history at
`~/.claude/projects/*.jsonl`, finds recurring patterns, and writes them
as Anthropic-format `SKILL.md` files into `~/.claude/skills/`. The next
time Claude Code starts, those skills auto-load and shape the agent's
behavior on your projects.

distill runs the upskill loop in two ways:

1. **Background.** A Claude Code plugin registers two hooks:
   `PostToolUse` (counter, every 30 tool calls) and `Stop` (every
   session end). When either fires, distill spawns a detached worker
   that scans recent sessions and decides whether to draft, extend, or
   skip a skill.
2. **Manual.** Run `distill upskill` whenever you want a one-off pass.

Mining itself runs on your existing Claude Code subscription via a
`claude -p` subprocess. No API key required, no separate inference
cost.

## Privacy

### Solo mode (default): anonymous metadata only

distill sends a small set of anonymous metrics to Plouto's OTEL
ingestion endpoint by default:

- phase names + durations (discover, harvest, prompt, judge, verdict, apply, state.advance)
- counts (sessions scanned, prompt/response pairs, prompt char count)
- verdict enum (KEEP / MERGE / SKIP) and parse status
- error categories on phase failures
- distill version, OS, arch
- an anonymous install-id (random UUIDv4 generated at first install)

distill never sends in solo mode:

- the content of your prompts or Claude's responses
- skill names or skill bodies
- source session UUIDs
- your git config user.email, hostname, or any repo paths
- tool call arguments or results

Mining itself (the `claude -p` subprocess) runs on your existing
Claude Code subscription. No API key, no separate inference cost.

### Opt out, anytime

```sh
distill telemetry off                            # disable permanently
DO_NOT_TRACK=1 distill upskill                   # environment-level opt-out
distill --no-telemetry upskill                   # per-command opt-out
distill telemetry endpoint <your-collector>      # ship to your own OTEL collector instead
```

The `DO_NOT_TRACK=1` env var is honored unconditionally per the
[Do Not Track](https://consoledonottrack.com/) convention.

### Team mode (consented at `distill team init`): full row capture

If you opt into team mode for cross-machine skill sharing, distill
captures session content (prompts, responses, tool I/O) and ships
to your team workspace. The consent flow at `distill team init`
spells out exactly what's captured before activating. Revert
anytime with `distill team leave`.

## Commands

| Command | What it does |
|---|---|
| `distill upskill` | Review recent sessions for a new skill (one-off) |
| `distill upskill --force` | Ignore the watermark and rescan recent sessions |
| `distill status` | Show mode, storage, skill counts, last run, identity |
| `distill install` | Register the Claude Code plugin (run automatically by `install.sh`) |
| `distill uninstall` | Remove the plugin registration (skills are preserved) |
| `distill telemetry <sub>` | `status` / `on` / `off` / `endpoint <url>` / `reset-install-id` / `test` |
| `distill upgrade` | Self-update to the latest GitHub Release (planned) |
| `distill enable` / `disable` | Flip auto-mining on/off (planned) |
| `distill hook <event>` | Internal: hook entry point used by Claude Code |
| `distill _mine` | Internal: detached worker entry, used by the hooks |

## How it decides what to upskill

distill assembles a prompt containing:

- The skills already present in your `~/.claude/skills/` (so the judge
  can decide whether to MERGE into one)
- Recent prompt and response pairs from up to 5 sessions newer than
  the last successful run

It passes the prompt to `claude -p`, parses a strict JSON verdict, and
takes one of three actions:

- **KEEP** writes a new `SKILL.md`
- **MERGE** extends an existing skill (version bump, merged source
  sessions, appended contributors if the editor differs from the
  author)
- **SKIP** advances the watermark with no file changes

The judge is told to default to SKIP. A skill should capture a
recurring pattern, not a single observation.

## Footprint

| Location | Contents |
|---|---|
| `~/.claude/skills/<name>/SKILL.md` | Mined skills, loaded by Claude Code natively |
| `~/.distill/bin/distill` | The single binary (~58 MB) |
| `~/.distill/state.json` | Watermark (last date + session UUID, versioned) |
| `~/.distill/logs/upskill.log` | Tagged trace from every phase (discover, harvest, judge, apply, state) |
| `~/.distill/counter.json` | Tool-call counter for the intra-session trigger |
| `~/.claude/plugins/cache/distill/...` | Plugin manifest + hooks.json (small, ~2 KB) |
| `~/.claude/plugins/installed_plugins.json` | distill is listed here as an installed plugin |
| `~/.claude/settings.json` | distill is enabled in `enabledPlugins` |

Total disk: about 58 MB for the binary, a few hundred bytes for state.

## Uninstall

```sh
distill uninstall
```

Removes the plugin registration, leaves your mined skills in
`~/.claude/skills/` untouched. To also remove the binary:

```sh
rm -rf ~/.distill
```

## Development

distill has zero npm dependencies. You need [Bun](https://bun.sh/) to
develop, and that is the only thing.

```sh
git clone https://github.com/mtrbls/distill.git
cd distill
bun src/cli.ts --version             # run from source
bun src/cli.ts upskill               # process your real sessions
bun run build                        # produce a binary at dist/distill
./dist/distill --version             # verify the binary works
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project posture, the
no-npm-deps rule, and the PR checklist.

## Releases

Binaries are published to [GitHub Releases](https://github.com/mtrbls/distill/releases)
for darwin-arm64, darwin-amd64, linux-arm64, and linux-amd64. Each
release ships a `SHA256SUMS` file the installer verifies against.

`install.sh` resolves the latest release tag at install time. Pin to a
specific version with `DISTILL_VERSION=v0.1.0 curl ... | sh`.

## License

[MIT](LICENSE).
