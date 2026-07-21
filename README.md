# skills

Reusable agent skills maintained by [orijinmain](https://github.com/orijinmain). Each skill is self-contained under `skills/` and can be discovered and installed with the open [`skills` CLI](https://github.com/vercel-labs/skills).

## Catalog

| Skill | Purpose |
| --- | --- |
| [`orchestrate-codex-agents`](skills/orchestrate-codex-agents/SKILL.md) | Route bounded work from a GPT-5.6 Sol orchestrator to Terra and Luna workers, with automatic escalation, one-writer control, and verification gates. |

## Install

Install and configure the orchestration skill, custom agents, managed policy, and Codex settings with one explicit command:

```bash
npx @orijinmain/codex-orchestration@latest setup
```

The command previews its plan and asks before writing. It backs up every replaced file or directory. Check an existing installation without changing it:

```bash
npx @orijinmain/codex-orchestration@latest status
```

### Skill-only installation

Interactively browse the skills in this repository:

```bash
npx skills@latest add orijinmain/skills
```

Install the orchestration skill globally for Codex without prompts:

```bash
npx skills@latest add orijinmain/skills \
  --skill orchestrate-codex-agents \
  --agent codex \
  --global \
  --yes
```

The `skills` CLI installs only the reusable workflow. For an offline or manual configuration, its bundled fallback script installs the Terra and Luna profiles and managed policy:

```bash
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py --dry-run
python3 ~/.codex/skills/orchestrate-codex-agents/scripts/install.py
```

The fallback script does not edit `config.toml`; merge `assets/config.snippet.toml` manually. The npm bootstrap performs that merge while preserving unrelated settings. Start a new Codex task after either installation path.

## Update

Rerun the bootstrap to update the complete installation:

```bash
npx @orijinmain/codex-orchestration@latest setup
```

Existing differing skill or agent files are reported as conflicts. After reviewing them, `setup --force` creates timestamped backups and replaces only the managed targets.

## Develop

Add each new skill as `skills/<skill-name>/SKILL.md`, keeping its scripts, references, assets, and agent metadata inside the same directory. Validate the complete catalog before committing:

```bash
python3 scripts/validate_repo.py
npm --prefix packages/codex-orchestration-cli test
```

The repository intentionally does not declare a license yet. Add one only after choosing the terms under which others may copy, modify, and redistribute the skills.
