# distill

Mine reusable skills from your Claude Code sessions.

## Install

```sh
curl -fsSL https://distill.plouto.ai/install.sh | sh
```

No npm, no npx, no Node runtime. Single self-contained binary.

## What it does

distill reads your local Claude Code session history at
`~/.claude/projects/*.jsonl`, finds recurring patterns, and writes them
as Anthropic-format SKILL.md files into `~/.claude/skills/`. The next
time Claude Code starts, those skills auto-load and shape the agent's
behavior on your projects.

Mining runs on your existing Claude Code subscription via a `claude -p`
subprocess. No API key required, no separate cost.

## Privacy

100% local. No telemetry, no cloud, no signup. distill reads your
local session files and runs them through your local Claude. Nothing
leaves the machine.

## Commands

| Command | What |
|---|---|
| `distill mine` | Manually mine recent sessions |
| `distill status` | Mode, storage location, skill counts, last mine |
| `distill enable` / `distill disable` | Flip auto-mining on/off |
| `distill upgrade` | Self-update to the latest GitHub Release |
| `distill uninstall` | Remove plugin registration and binary |

## License

MIT
