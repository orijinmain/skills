---
name: orchestrate-codex-agents
description: Design, install, run, and refine hierarchical Codex subagent orchestration using GPT-5.6 Sol as the root decision-maker and Terra or Luna custom agents as bounded workers. Use when Codex should route work by task type, risk, ambiguity, or complexity; automatically escalate or reassign subagent work; enforce one-writer and verification gates; configure reusable custom agent TOML files; or port a multi-agent policy across Codex environments.
---

# Orchestrate Codex Agents

Keep Sol responsible for requirements, decomposition, authority, conflict resolution, integration, and final verification. Delegate bounded work to Terra and Luna only when parallelism, specialization, or context isolation provides a material benefit.

## Apply the workflow

1. Inspect applicable `AGENTS.md`, `.codex/config.toml`, and custom agent files before changing or running orchestration.
2. Classify the task as `read`, `write`, `review`, or `decision`.
3. Apply hard risk gates before selecting a worker. Read [references/routing-policy.md](references/routing-policy.md) when designing or changing routing, escalation, budgets, or verification requirements.
4. Use `scripts/route_task.py` when a deterministic recommendation is useful. Treat its result as a policy recommendation; Sol retains final authority.
5. Spawn only independent, bounded subtasks. Give each worker scope, completion criteria, permitted paths, validation requirements, and the required return format.
6. Require every worker to return the handoff contract defined in the routing policy. Check an uncertain handoff with `scripts/validate_handoff.py`.
7. On `STATUS: ESCALATE`, have Sol inspect the evidence and launch the recommended next worker within existing authority. Do not let workers spawn other workers.
8. Have Sol verify evidence, changes, tests, conflicts, and residual risk before replying to the user.

## Preserve control boundaries

- Keep `agents.max_depth = 1` so only Sol orchestrates.
- Run read-only exploration in parallel when useful.
- Use one writer by default. Allow parallel writers only for explicitly disjoint paths.
- Route architecture, security, permissions, destructive operations, ambiguous requirements, and conflicting evidence to Sol.
- Ask the user only when escalation requires new authority, a destructive action, or a product decision that changes the requested outcome.
- Cap automatic escalation at three hops and a builder-reviewer correction loop at one pass. Have Sol take over after a circuit breaker trips.
- Do not spawn agents for trivial tasks or use escalation merely because work is slow or verbose.

## Install or update the portable policy

When the user asks to configure a fresh environment, prefer the public bootstrap because it installs the skill, agents, managed policy, and configuration together with conflict checks and backups:

```bash
npx @orijinmain/codex-orchestration@latest setup
```

Use the bundled installer as an offline or manual fallback:

```bash
python3 scripts/install.py --dry-run
python3 scripts/install.py
```

Pass `--codex-home PATH` for a non-default Codex home. Existing differing agent files are preserved unless the user explicitly authorizes `--force`; forced replacements receive timestamped backups. The fallback installer manages only its marked block in `AGENTS.md` and does not rewrite `config.toml`.

After installation, inspect `assets/config.snippet.toml` and merge the required `[agents]` values into the target configuration with `apply_patch`. Preserve unrelated settings. Start a new Codex task so the new global guidance and custom agents are loaded.

## Maintain the skill

- Keep portable defaults in `assets/agents/` and `assets/AGENTS.snippet.md`.
- Keep policy detail in `references/routing-policy.md`; avoid duplicating it in this file.
- Keep scripts dependency-free and compatible with Python 3.9 or later.
- Run representative script checks and `quick_validate.py` after every material change.
- Forward-test substantial routing changes on fresh, non-production tasks without leaking the intended route or answer.
