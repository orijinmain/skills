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

## Control model

Use Sol as the root orchestrator and final decision-maker. Sol owns requirements, authority, task decomposition, shared-file coordination, conflict resolution, acceptance criteria, and the final response.

Use the workers for bounded execution:

- `luna_fast`: exact lookup, extraction, classification, transformation, and short summaries.
- `luna_explorer`: multi-file discovery, comparison, log triage, test-failure grouping, and evidence-backed summaries.
- `terra_builder`: scoped implementation, fixes, refactoring, tests, and routine validation.
- `terra_reviewer`: independent review, reproduction, regression analysis, and test-gap detection.

Workers never spawn other workers. They return control to Sol through a structured handoff.

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

Route directly to Sol when any of these conditions materially affects the task:

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
| Read, single scope, low ambiguity | `luna_fast` | None by default |
| Read, multi or broad scope | `luna_explorer` | Sol verifies evidence |
| Write, bounded scope, low or medium risk | `terra_builder` | Reviewer when independent validation adds value |
| Review, low or medium risk | `terra_reviewer` | Builder only for a clearly scoped fix |
| Decision, high ambiguity, high risk, or hard gate | `sol` | Sol may split bounded follow-up work |

Use `scripts/route_task.py` to apply these defaults consistently.

## Execution state machine

Use these states:

```text
TRIAGE      Sol classifies, applies gates, and defines contracts.
DISCOVER    Luna gathers bounded evidence without editing.
BUILD       Terra Builder changes owned files and validates.
VERIFY      Terra Reviewer independently checks risky or important work.
INTEGRATE   Sol reconciles evidence, runs final checks, and responds.
```

Permitted transitions:

```text
TRIAGE -> DISCOVER | BUILD | VERIFY | INTEGRATE
DISCOVER -> BUILD | VERIFY | INTEGRATE
BUILD -> VERIFY | INTEGRATE
VERIFY -> BUILD | INTEGRATE
INTEGRATE -> DISCOVER | BUILD | VERIFY only when final verification exposes new bounded work
```

Sol records the escalation-hop count and whether the builder-reviewer correction loop has already been used.

## Handoff contract

Require every worker response to end with:

```text
STATUS: COMPLETE | ESCALATE
RECOMMENDED_NEXT: none | luna_explorer | terra_builder | terra_reviewer | sol
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

- `luna_fast -> luna_explorer`: multi-file relationships, comparison, provenance judgment, or log tracing emerges.
- `luna_fast -> terra_builder`: the required change and done condition are clear.
- `luna_fast -> terra_reviewer`: defect reproduction or independent review is needed.
- `luna_explorer -> terra_builder`: evidence identifies a bounded implementation.
- `luna_explorer -> terra_reviewer`: a suspected defect needs reproduction or independent validation.
- `terra_builder -> terra_reviewer`: a meaningful independent regression check is warranted.
- `terra_reviewer -> terra_builder`: a confirmed defect has a clear correction scope.
- `any worker -> sol`: a hard gate, conflicting evidence, scope expansion, or unclear authority appears.

Sol may decompose a task after escalation and delegate smaller pieces downward again. This is reassignment, not worker-controlled nesting.

## Verification gates

Require independent review when any of these apply:

- User-visible behavior changes across multiple components.
- A fix addresses concurrency, persistence, caching, retries, or error recovery.
- Tests were added or changed to define previously ambiguous behavior.
- A builder reports medium residual risk or incomplete validation.
- The user explicitly asks for review or high assurance.

Sol must directly verify or take over when:

- A reviewer reports high or critical risk.
- The same validation fails twice.
- Builder and reviewer disagree on correctness.
- The proposed fix expands beyond the authorized scope.

## Budgets and circuit breakers

- Default to at most three concurrent read workers.
- Default to one writer. Use multiple writers only for explicitly disjoint paths.
- Cap automatic escalation at three hops for the same issue.
- Allow one `terra_builder <-> terra_reviewer` correction loop.
- After a repeated blocker or exhausted budget, have Sol act directly or request the missing user decision.
- Do not delegate a trivial task whose coordination overhead exceeds its execution cost.
