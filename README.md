# skills

Reusable agent skills maintained by [orijinmain](https://github.com/orijinmain). Each skill is self-contained under `skills/` and can be discovered and installed with the open [`skills` CLI](https://github.com/vercel-labs/skills).

## Catalog

| Skill | Purpose |
| --- | --- |
| [`orchestrate-codex-agents`](skills/orchestrate-codex-agents/SKILL.md) | Route bounded work from a GPT-5.6 Sol orchestrator to Terra and Luna workers, with automatic escalation, one-writer control, and verification gates. |

## Install

Install the complete orchestration setup—the skill, custom agents, managed policy, and required Codex settings—with one command:

```bash
npx @orijinmain/codex-orchestration setup
```

This is the official full-install path. The command previews its plan and asks before writing, preserves unrelated configuration, and backs up every replaced file or directory. Check an installation without changing it:

```bash
npx @orijinmain/codex-orchestration status
```

Start a new Codex task after setup so the installed guidance and custom agents are loaded.

### Optional skill-only installation

Use the open `skills` CLI when you want only the reusable skill folder:

```bash
npx skills add https://github.com/orijinmain/skills \
  --skill orchestrate-codex-agents \
  --agent codex \
  --global \
  --yes
```

This does not install the Terra and Luna custom-agent profiles or update `AGENTS.md` and `config.toml`; use the official bootstrap above for a complete installation.

## Update

Rerun the bootstrap to update the complete installation:

```bash
npx @orijinmain/codex-orchestration setup
```

Existing differing skill or agent files are reported as conflicts. After reviewing them, `setup --force` creates timestamped backups and replaces only the managed targets.

## Develop

Add each new skill as `skills/<skill-name>/SKILL.md`, keeping its scripts, references, assets, and agent metadata inside the same directory. Validate the complete catalog before committing:

```bash
python3 scripts/validate_repo.py
npm --prefix packages/codex-orchestration-cli test
```

The repository intentionally does not declare a license yet. Add one only after choosing the terms under which others may copy, modify, and redistribute the skills.
