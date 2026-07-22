# orijinmain Skills

Reusable Codex skills and plugins maintained by [orijinmain](https://github.com/orijinmain).

## Corch for Codex

Corch is a detachable `codex-orchestration` plugin for adaptive root-agent orchestration. Its canonical top-level role is the model-independent `orchestrator`. Bounded work is delegated to task-oriented workers only when specialization, parallelism, or context isolation adds material value.

The plugin is self-contained. It does not edit global `AGENTS.md`, copy custom-agent TOML files into `~/.codex/agents`, or alter `config.toml`.

### Install the plugin

Add this repository as a Codex marketplace and install the plugin:

```bash
codex plugin marketplace add https://github.com/orijinmain/skills.git
codex plugin add codex-orchestration@orijinmain-skills
```

Start a new Codex task afterward, run `/hooks`, review the bundled commands, and trust them. The default orchestration mode is `full`; no setup command is required.

The packaged CLI remains an optional convenience that performs the same plugin installation and safely migrates an owned earlier mode configuration:

```bash
npx @orijinmain/corch setup
```

Use `--mode off|lite|full|ultra` only when you want to choose a persistent default during that setup.

### Virtual workers and automatic selection

The root agent delegates with stable Corch role names encoded in `spawn_agent` task names. A `PreToolUse` hook reads `<role>__<task>` and prepends the matching contract immediately before execution; `SubagentStart` adds the shared worker policy.

| Virtual role | Task-name form | Intended work |
| --- | --- | --- |
| `lookup` | `lookup__<task>` | Exact, low-risk reads and transformations |
| `explore` | `explore__<task>` | Multi-file discovery and evidence gathering |
| `build` | `build__<task>` | Bounded implementation and tests |
| `review` | `review__<task>` | Independent review and reproduction |

Corch does not depend on the conditional `agent_type` field. It intentionally omits `model` and `reasoning_effort` by default, so Codex chooses a task-appropriate balance of intelligence and speed using its native subagent selection. Role names describe work rather than imply a model. Explicit overrides already supplied by the spawn surface are preserved, leaving room for a fixed mode later.

The selected model is available to the `SubagentStart` hook and is included in its diagnostic message. The current hook API does not expose the selected reasoning effort, so Corch cannot reliably log or assert that value. See [Choosing models and reasoning](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning) for the native behavior.

Separate files under `~/.codex/agents` are not required.

### Modes

| Mode | Behavior |
| --- | --- |
| `off` | Disable only the plugin's automatic orchestration. |
| `lite` | Delegate rarely, prefer serial work, and review selectively. |
| `full` | Apply adaptive routing, useful read parallelism, and verification gates. |
| `ultra` | Decompose substantial work earlier and independently review important writes. |

Change only the current session with `$corch off|lite|full|ultra`, inspect it with `$corch status`, or set the default for new sessions with `$corch default off|lite|full|ultra`. On surfaces where a `$` mention is inconvenient, use the exact fallback `corch ...` form. Persistent state is stored in the plugin's own data directory.

`off` cannot disable orchestration instructions that already exist outside the plugin, such as an unmarked block in global `AGENTS.md`.

### Inspect, migrate, or remove

```bash
npx @orijinmain/corch status
npx @orijinmain/corch uninstall
```

For repeated maintenance, install the CLI globally and then run it explicitly:

```bash
npm install -g @orijinmain/corch
corch setup
corch status
```

Installing the npm package globally installs the `corch` command; `corch setup` is what installs the Codex plugin. Corch retains the `codex-orchestration` plugin ID and uses `$corch` controls.

`setup` migrates an owned earlier mode config into plugin data. Unrelated files and marketplace state are preserved. `uninstall` removes the plugin and its owned data while retaining the marketplace for other plugins.

## Skill-only use

Corch exposes one public skill at [`skills/corch`](skills/corch/SKILL.md). Its implicit invocation is disabled so an installed plugin in `off` mode cannot reactivate itself. Runtime policies and deterministic helpers live under `runtime/` and are packaged as internal plugin resources rather than additional discoverable skills.

Install only the reusable control and guidance skill, without Hooks or automatic virtual-worker routing, with:

```bash
npx skills add https://github.com/orijinmain/skills \
  --skill corch \
  --agent codex \
  --global \
  --yes
```

## Development

```bash
python3 scripts/validate_repo.py
npm --prefix packages/codex-orchestration-cli test
npm pack ./packages/codex-orchestration-cli --dry-run
```

The repository intentionally does not declare a public license yet.
