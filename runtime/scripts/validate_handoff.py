#!/usr/bin/env python3
"""Validate a structured subagent handoff block."""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List


REQUIRED_FIELDS = (
    "STATUS",
    "MODEL",
    "RECOMMENDED_NEXT",
    "REASON",
    "COMPLETED_WORK",
    "EVIDENCE",
    "NEXT_SCOPE",
    "RISK",
    "VALIDATION",
    "FILES_TOUCHED",
)
ALLOWED_STATUS = {"COMPLETE", "ESCALATE"}
ALLOWED_NEXT = {"none", "explore", "build", "review", "orchestrator"}
ALLOWED_RISK = {"low", "medium", "high", "critical"}
ALLOWED_VALIDATION = {"pass", "fail", "not_run"}
FIELD_RE = re.compile(r"^([A-Z_]+):\s*(.*)$")


def parse_fields(text: str) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    for line in text.splitlines():
        match = FIELD_RE.match(line.strip())
        if match:
            fields[match.group(1)] = match.group(2).strip()
    return fields


def validate(fields: Dict[str, str]) -> List[str]:
    errors: List[str] = []
    for field in REQUIRED_FIELDS:
        if field not in fields:
            errors.append(f"missing field: {field}")
        elif not fields[field]:
            errors.append(f"empty field: {field}")

    if errors:
        return errors

    if fields["STATUS"] not in ALLOWED_STATUS:
        errors.append("STATUS must be COMPLETE or ESCALATE")
    if fields["RECOMMENDED_NEXT"] not in ALLOWED_NEXT:
        errors.append("RECOMMENDED_NEXT has an unsupported value")
    if fields["RISK"] not in ALLOWED_RISK:
        errors.append("RISK must be low, medium, high, or critical")
    if fields["VALIDATION"] not in ALLOWED_VALIDATION:
        errors.append("VALIDATION must be pass, fail, or not_run")

    if fields["STATUS"] == "COMPLETE" and fields["RECOMMENDED_NEXT"] != "none":
        errors.append("COMPLETE requires RECOMMENDED_NEXT: none")
    if fields["STATUS"] == "ESCALATE":
        if fields["RECOMMENDED_NEXT"] == "none":
            errors.append("ESCALATE requires a non-none RECOMMENDED_NEXT")
        if fields["NEXT_SCOPE"].lower() == "none":
            errors.append("ESCALATE requires an actionable NEXT_SCOPE")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Codex worker handoff.")
    parser.add_argument("path", nargs="?", help="Handoff file; omit to read stdin.")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    text = Path(args.path).read_text(encoding="utf-8") if args.path else sys.stdin.read()
    fields = parse_fields(text)
    errors = validate(fields)

    if args.as_json:
        print(json.dumps({"valid": not errors, "errors": errors, "fields": fields}, indent=2))
    elif errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
    else:
        print("OK: handoff contract is valid")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
