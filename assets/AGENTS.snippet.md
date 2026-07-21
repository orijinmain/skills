<!-- orchestrate-codex-agents:start -->
## Hierarchical subagent orchestration

Keep the root agent on `gpt-5.6-sol`. The root owns requirements, decomposition, authority, conflict resolution, integration, and final verification.

Before acting, decide whether delegation provides a material benefit through parallelism, specialization, or context isolation. Handle trivial tasks directly.

Route bounded work as follows:

- `luna_fast`: exact lookup, extraction, classification, transformation, and short summaries.
- `luna_explorer`: multi-file discovery, comparison, log triage, test-failure grouping, and evidence-backed summaries.
- `terra_builder`: scoped implementation, fixes, refactoring, tests, and routine validation.
- `terra_reviewer`: independent review, reproduction, regression analysis, and test-gap detection.
- Root Sol: architecture, security, permissions, destructive operations, ambiguous requirements, conflicting evidence, and final decisions.

Use one writer by default. Parallelize read-only work when useful. Never let multiple workers edit the same file concurrently.

Workers must not spawn other workers. Each worker must end its report with:

```text
STATUS: COMPLETE | ESCALATE
RECOMMENDED_NEXT: none | luna_explorer | terra_builder | terra_reviewer | sol
REASON: concise completion or escalation reason
COMPLETED_WORK: work already completed
EVIDENCE: paths, locations, commands, or outputs
NEXT_SCOPE: minimum scope for the next agent, or none
RISK: low | medium | high | critical
VALIDATION: pass | fail | not_run
FILES_TOUCHED: comma-separated paths, or none
```

When a worker returns `STATUS: ESCALATE`, Sol must inspect the evidence and automatically reassign the minimum next scope within existing authority:

- `luna_fast -> luna_explorer` for multi-file analysis.
- `luna_fast -> terra_builder` for a clearly scoped change.
- `luna_fast -> terra_reviewer` for reproduction or review.
- `luna_explorer -> terra_builder` for implementation.
- `luna_explorer -> terra_reviewer` for independent validation.
- `terra_builder -> terra_reviewer` for meaningful regression review.
- `terra_reviewer -> terra_builder` for a confirmed, clearly scoped fix.
- Any worker `-> sol` for architecture, security, authority, destructive actions, ambiguity, scope expansion, or conflicting evidence.

Ask the user only when escalation needs new authority, a destructive action, or a decision that changes the requested outcome.

Cap automatic escalation at three hops. Allow one builder-reviewer correction loop. After a circuit breaker trips, Sol handles the issue directly or requests the missing user decision.
<!-- orchestrate-codex-agents:end -->
