# Routing Policy

## Contents

1. Control model
2. Task classification
3. Hard gates
4. Initial routing
5. Execution state machine
6. Handoff contract
7. Escalation and reassignment
8. Verification gates
9. Budgets and circuit breakers
10. Mode intensity

## Control model

Use `orchestrator` as the canonical, model-independent root role and final decision-maker. The orchestrator owns requirements, authority, task decomposition, shared-file coordination, conflict resolution, acceptance criteria, and the final response.

Use the workers for bounded execution:

- `lookup`: exact lookup, extraction, classification, transformation, and short summaries.
- `explore`: multi-file discovery, comparison, log triage, test-failure grouping, and evidence-backed summaries.
- `build`: scoped implementation, fixes, refactoring, tests, and routine validation.
- `review`: independent review, reproduction, regression analysis, and test-gap detection.

Workers never spawn other workers. They return control to the orchestrator through a structured handoff.

These four names are Corch's complete set of task-oriented virtual worker roles. When the plugin is active, the orchestrator encodes the role in `spawn_agent`'s `task_name` as `<role>__<task>`, for example `explore__release_changes`. The `PreToolUse` hook reads and preserves that task name, then prepends the matching role contract before execution. Do not pass Corch virtual role names through `agent_type`. Omit model and reasoning effort by default so Codex can choose them automatically for the task, and preserve explicit user-requested overrides.

## Task classification

Classify the immediate subtask before selecting a worker:

| Kind | Meaning |
| --- | --- |
| `read` | Inspect or transform information without changing authoritative files. |
| `write` | Modify code, tests, configuration, or other project artifacts. |
| `review` | Independently assess correctness, regressions, or missing validation. |
| `decision` | Resolve architecture, security, authority, product, or conflicting-evidence questions. |

Also record:

- Scope: `single`, `multi`, or `broad`.
- Ambiguity: `low`, `medium`, or `high`.
- Risk: `low`, `medium`, `high`, or `critical`.
- Validation need: `none`, `normal`, or `independent`.

## Hard gates

Route directly to the orchestrator when any of these conditions materially affects the task:

- Architecture or cross-system design decisions.
- Authentication, authorization, secrets, security boundaries, or privacy.
- Destructive or difficult-to-recover operations.
- Data or schema migrations with compatibility risk.
- External side effects involving money, publishing, messaging, deployment, or account state.
- High ambiguity that could change the requested outcome.
- Conflicting evidence from workers.
- New authority or user choice is required.

Do not treat file count or output length alone as a hard gate.

## Initial routing

Apply hard gates first, then use this table:

| Task condition | Initial agent | Follow-up |
| --- | --- | --- |
| Read, single scope, low ambiguity | `lookup` | None by default |
| Read, multi or broad scope | `explore` | Orchestrator verifies evidence |
| Write, bounded scope, low or medium risk | `build` | `review` when independent validation adds value |
| Review, low or medium risk | `review` | `build` only for a clearly scoped fix |
| Decision, high ambiguity, high risk, or hard gate | `orchestrator` | Orchestrator may split bounded follow-up work |

Use `scripts/route_task.py` to apply these defaults consistently.

## Execution state machine

Use these states:

```text
TRIAGE      Orchestrator classifies, applies gates, and defines contracts.
DISCOVER    Lookup or Explore gathers bounded evidence without editing.
BUILD       Build changes owned files and validates.
VERIFY      Review independently checks risky or important work.
INTEGRATE   Orchestrator reconciles evidence, runs final checks, and responds.
```

Permitted transitions:

```text
TRIAGE -> DISCOVER | BUILD | VERIFY | INTEGRATE
DISCOVER -> BUILD | VERIFY | INTEGRATE
BUILD -> VERIFY | INTEGRATE
VERIFY -> BUILD | INTEGRATE
INTEGRATE -> DISCOVER | BUILD | VERIFY only when final verification exposes new bounded work
```

The orchestrator records the escalation-hop count and whether the builder-reviewer correction loop has already been used.

## Handoff contract

Require every worker response to end with:

```text
STATUS: COMPLETE | ESCALATE
RECOMMENDED_NEXT: none | explore | build | review | orchestrator
REASON: concise completion or escalation reason
COMPLETED_WORK: work already completed
EVIDENCE: paths, locations, commands, or outputs supporting the result
NEXT_SCOPE: minimum scope for the next agent, or none
RISK: low | medium | high | critical
VALIDATION: pass | fail | not_run
FILES_TOUCHED: comma-separated paths, or none
```

For `COMPLETE`, require `RECOMMENDED_NEXT: none`. For `ESCALATE`, require a non-`none` recommendation and an actionable `NEXT_SCOPE`.

Validate machine-consumed handoffs with `scripts/validate_handoff.py`.

## Escalation and reassignment

- `lookup -> explore`: multi-file relationships, comparison, provenance judgment, or log tracing emerges.
- `lookup -> build`: the required change and done condition are clear.
- `lookup -> review`: defect reproduction or independent review is needed.
- `explore -> build`: evidence identifies a bounded implementation.
- `explore -> review`: a suspected defect needs reproduction or independent validation.
- `build -> review`: a meaningful independent regression check is warranted.
- `review -> build`: a confirmed defect has a clear correction scope.
- `any worker -> orchestrator`: a hard gate, conflicting evidence, scope expansion, or unclear authority appears.

The orchestrator may decompose a task after escalation and delegate smaller pieces downward again. This is reassignment, not worker-controlled nesting.

## Verification gates

Require independent review when any of these apply:

- User-visible behavior changes across multiple components.
- A fix addresses concurrency, persistence, caching, retries, or error recovery.
- Tests were added or changed to define previously ambiguous behavior.
- A builder reports medium residual risk or incomplete validation.
- The user explicitly asks for review or high assurance.

The orchestrator must directly verify or take over when:

- A reviewer reports high or critical risk.
- The same validation fails twice.
- Builder and reviewer disagree on correctness.
- The proposed fix expands beyond the authorized scope.

## Budgets and circuit breakers

- Default to at most three concurrent read workers.
- Default to one writer. Use multiple writers only for explicitly disjoint paths.
- Cap automatic escalation at three hops for the same issue.
- Allow one `build <-> review` correction loop.
- After a repeated blocker or exhausted budget, have the orchestrator act directly or request the missing user decision.
- Do not delegate a trivial task whose coordination overhead exceeds its execution cost.

## Mode intensity

Apply the invariant control, safety, authority, one-writer, and escalation limits in every active mode. Change only the delegation threshold and verification intensity:

| Mode | Delegation and verification behavior |
| --- | --- |
| `off` | Disable only this plugin's automatic orchestration. |
| `lite` | Use a high delegation threshold, mostly serial work, and selective review. |
| `full` | Use standard adaptive routing, useful read parallelism, and risk-based verification. |
| `ultra` | Decompose substantial work earlier, parallelize independent reads, and independently review important writes. |

Read the matching `mode-*.md` reference for the concise runtime policy. Never interpret a higher mode as broader authority, weaker safety, or a requirement to delegate trivial work.
