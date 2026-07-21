# skills

Reusable agent skills maintained by [jjinkang](https://github.com/jjinkang). Each skill is self-contained under `skills/` and can be discovered and installed with the open [`skills` CLI](https://github.com/vercel-labs/skills).

## Catalog

| Skill | Purpose |
| --- | --- |
| [`orchestrate-codex-agents`](skills/orchestrate-codex-agents/SKILL.md) | Route bounded work from a GPT-5.6 Sol orchestrator to Terra and Luna workers, with automatic escalation, one-writer control, and verification gates. |

## Install

Interactively browse the skills in this repository:

```bash
npx skills@latest add jjinkang/skills
```

Install the orchestration skill globally for Codex without prompts:

```bash
npx skills@latest add jjinkang/skills \
  --skill orchestrate-codex-agents \
  --agent codex \
  --global \
  --yes
```

The skill itself is installed by the `skills` CLI. Its bundled setup script separately installs the reusable Terra and Luna agent profiles and the managed orchestration policy:

```bash
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py --dry-run
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py
```

Review `~/.codex/skills/orchestrate-codex-agents/assets/config.snippet.toml`, merge its settings into `~/.codex/config.toml`, and start a new Codex task so the configuration is reloaded.

## Update

Update the installed skill, then preview and apply any portable policy changes:

```bash
npx skills update orchestrate-codex-agents --global --yes
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py --dry-run --force
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py --force
```

Forced policy updates create timestamped backups before replacing differing managed files.

## Develop

Add each new skill as `skills/<skill-name>/SKILL.md`, keeping its scripts, references, assets, and agent metadata inside the same directory. Validate the complete catalog before committing:

```bash
python3 scripts/validate_repo.py
```

The repository intentionally does not declare a license yet. Add one only after choosing the terms under which others may copy, modify, and redistribute the skills.
