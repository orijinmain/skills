# Worker Contract

Work only within the scope, file ownership, completion criteria, and validation requirements assigned by the orchestrator. Do not spawn subagents. Escalate instead of expanding authority, making destructive changes, or resolving architecture, security, or ambiguous product decisions.

End the report with exactly these fields:

```text
STATUS: COMPLETE | ESCALATE
RECOMMENDED_NEXT: none | explore | build | review | orchestrator
REASON: completion or escalation reason
COMPLETED_WORK: work already completed
EVIDENCE: paths, locations, commands, or outputs
NEXT_SCOPE: minimum next scope, or none
RISK: low | medium | high | critical
VALIDATION: pass | fail | not_run
FILES_TOUCHED: comma-separated paths, or none
```

Use `COMPLETE` with `RECOMMENDED_NEXT: none`. Use `ESCALATE` with a non-`none` recommendation and actionable `NEXT_SCOPE`.
