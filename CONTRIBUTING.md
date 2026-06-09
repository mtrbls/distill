# Contributing to distill

Thanks for the interest. distill is small and stays small: a couple
thousand lines of TypeScript wrapped around `claude -p` and a SKILL.md
writer. Patches that fit that posture are very welcome.

## Project posture

A few things to know before you write code:

- **Zero npm dependencies.** No `node_modules`, no `bun.lock`. distill
  uses Bun's native TypeScript handling. PRs that add an npm dep will
  need a strong justification.
- **No telemetry, no cloud, no signup.** Solo mode reads local files
  and runs through the user's local `claude` CLI. Nothing leaves the
  machine. PRs that introduce network calls in solo mode are out of
  scope.
- **One binary.** End users get a single self-contained executable
  from `bun build --compile`. PRs that require a separate runtime
  (Node, Python, etc.) at install time are out of scope.
- **Tight scope.** distill mines reusable skills from Claude Code
  session JSONLs. That's it. PRs that expand the surface to other
  agents, other shells, or other domains belong in a different repo.

## Development

```sh
git clone https://github.com/mtrbls/distill.git
cd distill
bun src/cli.ts --version             # run from source
bun src/cli.ts mine                  # mine your real sessions
bun run build                        # produce a binary at dist/distill
./dist/distill --version             # verify the binary
```

No `bun install` step. There is nothing to install.

## Building cross-platform binaries

```sh
bun run build:darwin-arm64
bun run build:darwin-amd64
bun run build:linux-arm64
bun run build:linux-amd64
bun run build:all                    # all four at once
```

Each produces a single binary in `dist/`.

## Where the code lives

- `src/cli.ts` — subcommand dispatcher
- `src/mine.ts` — the mining flow (parse JSONL, build judge prompt,
  call `claude -p`, parse verdict, write SKILL.md, advance watermark)
- `src/skill.ts` — SKILL.md frontmatter read/write
- `src/plugin.ts` — Claude Code plugin registration
- `install.sh` — POSIX install script for end users

Four source files. Keep it that way if possible.

## Pull request checklist

Before opening a PR:

- The change does not add an npm dependency
- The change does not introduce a network call in solo mode
- `bun src/cli.ts --version` still prints
- `bun run build` still produces a working binary
- Manual smoke test: `bun src/cli.ts mine` against your own
  `~/.claude/projects/`
- Commit message uses imperative subject line, no Co-Authored-By trailer
- The diff is small. distill is small.

## Reporting bugs

Open an issue with:

- distill version (`distill --version`)
- Output of `distill status`
- The command you ran and the output you saw
- Your OS and architecture

For security issues, see [SECURITY.md](SECURITY.md). Do not open a
public issue for a security report.
