# @orijinmain/corch

Corch packages a detachable Codex plugin with a model-independent `orchestrator` root role and task-oriented workers. The plugin activates through lifecycle hooks without modifying global `AGENTS.md`, `config.toml`, or `~/.codex/agents`.

## Plugin-first installation

The plugin works by itself; a separate setup script is not required:

```bash
codex plugin marketplace add https://github.com/orijinmain/skills.git
codex plugin add codex-orchestration@orijinmain-skills
```

Start a new Codex task, review `/hooks`, and trust the bundled commands. The built-in default mode is `full`.

Corch encodes each virtual worker role in `spawn_agent`'s `task_name` as `<role>__<task>`. `PreToolUse` reads and preserves that task name, then prepends the matching role contract before execution. `SubagentStart` injects the shared worker policy:

| Virtual role | Task-name form | Intended work |
| --- | --- | --- |
| `lookup` | `lookup__<task>` | Exact, low-risk reads and transformations |
| `explore` | `explore__<task>` | Multi-file discovery and evidence gathering |
| `build` | `build__<task>` | Bounded implementation and tests |
| `review` | `review__<task>` | Independent review and reproduction |

The hook does not use `agent_type` for virtual routing. It omits `model` and `reasoning_effort` by default so Codex can select both natively for the task. Role names describe work rather than imply a model. Explicit overrides already present in the spawn input are preserved. `SubagentStart` exposes the selected model, but the current hook input does not expose selected reasoning effort, so Corch cannot reliably record that value.

## Optional setup and migration CLI

Use the CLI when you want one command to install the marketplace and plugin, choose an initial mode, or migrate an owned earlier mode configuration:

```bash
npx @orijinmain/corch setup
npx @orijinmain/corch setup --mode lite
```

Setup does not install custom-agent TOML files or edit global instructions. It can move an owned earlier mode config into plugin data; unrelated files are preserved.

For repeated maintenance:

```bash
npm install -g @orijinmain/corch
corch setup
corch status
corch uninstall
```

The global npm install adds the `corch` command but does not activate the Codex plugin until `corch setup` runs.

## Modes and controls

- `off`: plugin automation is inactive; explicit user-requested delegation still works.
- `lite`: high delegation threshold, mostly serial execution, selective review.
- `full`: adaptive routing and risk-based verification; the default.
- `ultra`: earlier decomposition and independent review of important writes.

Within Codex, use `$corch status`, `$corch off|lite|full|ultra`, or `$corch default off|lite|full|ultra`. The exact fallback `corch ...` form is also supported. Persistent defaults and session state live under the plugin data directory.

Corch keeps the existing plugin ID and exposes one public skill named `corch`; its policies and helpers are internal runtime resources. Use `--codex-home PATH` to target another Codex home, `--dry-run` to preview, and `--yes` for authorized non-interactive changes. No npm lifecycle script changes the Codex environment; only an explicit Corch command does.

## Development

Hook input and output types are generated from the official OpenAI Codex JSON
Schemas vendored under `schemas/codex-hooks/rust-v0.144.5`. The release is
pinned because schemas from the Codex `main` branch may include unreleased
fields. Regenerate and verify the checked-in types with:

```bash
npm run generate:hook-types
npm run check:hook-types
```

The official `PreToolUse` schema intentionally leaves `tool_input` as an
unknown JSON value. Corch validates the current `spawn_agent` fields it uses at
runtime and preserves additional fields for forward compatibility.
