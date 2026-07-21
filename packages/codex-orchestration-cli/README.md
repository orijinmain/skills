# @jjinkang/codex-orchestration

Safely install the `orchestrate-codex-agents` skill, Terra and Luna custom agents, managed global guidance, and the required Codex configuration.

```bash
npx @jjinkang/codex-orchestration@latest setup
```

For a persistent command, install the same package globally:

```bash
npm install --global @jjinkang/codex-orchestration@latest
codex-orchestration setup
```

The command previews its plan and asks before writing. Existing differing skill or agent files are treated as conflicts. Review them before opting into replacement:

```bash
npx @jjinkang/codex-orchestration@latest setup --dry-run
npx @jjinkang/codex-orchestration@latest setup --force
```

Every replaced file or directory receives a timestamped sibling backup. Configuration updates back up the complete existing `config.toml`. No package lifecycle script modifies the Codex environment; changes happen only after an explicit `setup` command.

Check an installation without changing it:

```bash
npx @jjinkang/codex-orchestration@latest status
```

Run `setup` again to update an existing installation. It remains conservative: differing skill or agent files stop the update until you review the conflicts and explicitly use `--force`.

Use `--codex-home PATH` to target a non-default Codex home. Add `--yes` for an authorized non-interactive setup. Use `--skip-policy` or `--skip-config` when those files are managed separately, and pass the same skip flags to `status`.
