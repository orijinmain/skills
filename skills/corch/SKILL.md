---
name: corch
description: Control, operate, diagnose, or maintain the installed Codex orchestration plugin. Invoke explicitly as $corch to inspect or change the session mode, set the persistent default to off, lite, full, or ultra, understand task routing, or troubleshoot plugin activation and worker selection.
---

# Corch

Use this single Codex-native surface for orchestration control and guidance.

## Control the plugin

Use one of these exact invocations:

```text
$corch
$corch status
$corch off
$corch lite
$corch full
$corch ultra
$corch default off
$corch default lite
$corch default full
$corch default ultra
```

The `UserPromptSubmit` Hook consumes exact controls before they reach the model. On surfaces where a `$` mention is inconvenient, use exact `corch ...` commands. If controls are unavailable, verify that the plugin is installed and enabled, then review and trust its commands with `/hooks`.

`$corch status` reports the active and default modes plus the five most recent workers and the exact model reported by Codex for each. The current Hook API does not expose worker reasoning effort.

## Understand orchestration

- The `orchestrator` owns requirements, decomposition, authority, shared-file coordination, conflict resolution, integration, and final verification.
- `lookup` handles exact low-risk reads, `explore` investigates relationships and evidence, `build` performs bounded changes, and `review` independently checks results.
- For delegated work, encode the virtual role in `spawn_agent`'s `task_name` as `<role>__<task>`, such as `review__security_risks`. Do not pass Corch virtual role names through `agent_type`.
- Worker model and reasoning effort are unpinned by default so Codex can select them natively. Preserve explicit user overrides. Copy the runtime-reported model into the structured handoff's `MODEL` field and include worker-to-model mappings in the orchestrator summary.
- `off` disables plugin-driven delegation, `lite` delegates sparingly, `full` applies adaptive routing and verification, and `ultra` decomposes substantial work earlier with stronger review.
- Workers never create workers. They return structured handoffs to the orchestrator, with at most three automatic escalation hops and one `build`–`review` correction loop.
- Keep one writer per overlapping path and delegate only when parallelism, specialization, or context isolation provides material value.

## Install or maintain

Use Codex CLI 0.144.5 or later; the latest release is recommended.

The complete plugin can be installed directly from the marketplace:

```bash
codex plugin marketplace add https://github.com/orijinmain/skills.git
codex plugin add codex-orchestration@orijinmain-skills
```

Corch is also available as an optional setup and maintenance CLI:

```bash
npx @orijinmain/corch setup
npx @orijinmain/corch status
npx @orijinmain/corch uninstall
```

Runtime policies are packaged as plugin-internal resources and injected by Hooks. This skill's implicit invocation remains disabled so `off` cannot reactivate itself through skill matching.
