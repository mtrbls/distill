# distill

Turns your Claude Code sessions into reusable skills, automatically.

```sh
curl -fsSL https://raw.githubusercontent.com/mtrbls/distill/main/install.sh | sh
```

One self-contained binary. No npm, no Node, no cloud, no signup.

## How it works

distill watches your Claude Code sessions in the background (every 20
prompts and at each session end). When it spots a recurring pattern,
a mistake you caught twice, a workflow you repeat, a check you skipped
and regretted, it writes a standard `SKILL.md` that Claude Code loads
automatically in your next session.

The analysis runs through your own `claude` CLI, on your existing
subscription. Nothing leaves your machine.

Skills mined from work in a git repo land in that repo's
`.claude/skills/` — detected automatically, nothing to configure.
Everything else goes to `~/.claude/skills/`.

Codex sessions are mined too (`~/.codex/sessions`): skills from
Codex work land where Codex loads them — `.agents/skills/` in the
repo, `~/.agents/skills/` otherwise. Same format, same candidate →
promote lifecycle. `distill install` wires Codex's `notify` hook
automatically when Codex is present.

A pattern seen once becomes a *candidate* in `.claude/skill-candidates/`
(dormant, never loaded, zero cost). When the pattern shows up again —
in your work or a teammate's — the candidate is promoted to a real
skill. Candidates that never recur quietly expire.

## Teams

No setup. When a skill lands in your project repo, commit it like any
file (PR review if your team wants it). Teammates get it with their
next `git pull`, and their Claude loads it from there. Skills they
mine flow back the same way.

## Commands

You rarely need any of these. The background loop does the work.

| Command | What it does |
|---|---|
| `distill upskill` | Run an analysis pass now |
| `distill usage` | Token and tool usage from your local sessions |
| `distill status` | What distill knows: skills, last run, connection |
| `distill connect` | Optional: link to a Plouto workspace for usage dashboards |
| `distill uninstall` | Remove the plugin. Your skills stay. |

`--json` works everywhere.

## Privacy

- Default: zero network traffic. Skills are local files, sharing is
  your own git remote.
- `distill connect` (optional) syncs session metadata to Plouto:
  token counts, model names, tool names, timestamps. Never prompts,
  never code, never file contents.
- `DO_NOT_TRACK=1` and `distill telemetry off` are always honored.

## Uninstall

```sh
distill uninstall
rm -rf ~/.distill
```

Skills in `~/.claude/skills/` and your repos are untouched.

## Development

Requires [Bun](https://bun.sh), nothing else. There are zero
dependencies and no install step.

```sh
git clone https://github.com/mtrbls/distill.git && cd distill
bun test
bun run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
