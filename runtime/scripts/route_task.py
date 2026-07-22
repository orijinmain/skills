#!/usr/bin/env python3
"""Return a deterministic agent-routing recommendation."""

import argparse
import json
from typing import Dict, List, Set


HARD_FLAGS = {
    "architecture",
    "security",
    "permissions",
    "destructive",
    "migration",
    "external-side-effect",
    "conflicting-evidence",
    "new-authority",
}


def parse_flags(raw: str) -> Set[str]:
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def route(args: argparse.Namespace) -> Dict[str, object]:
    flags = parse_flags(args.flags)
    hard_flags = sorted(flags & HARD_FLAGS)
    reasons: List[str] = []
    hard_gate = False
    follow_up = "none"

    if hard_flags:
        agent = "orchestrator"
        hard_gate = True
        reasons.append("hard gate: " + ", ".join(hard_flags))
    elif args.kind == "decision":
        agent = "orchestrator"
        hard_gate = True
        reasons.append("decision work stays with the root orchestrator")
    elif args.risk in {"high", "critical"}:
        agent = "orchestrator"
        hard_gate = True
        reasons.append(f"{args.risk} risk requires root ownership")
    elif args.ambiguity == "high":
        agent = "orchestrator"
        hard_gate = True
        reasons.append("high ambiguity could change the requested outcome")
    elif args.kind == "read":
        if args.scope == "single" and args.ambiguity == "low":
            agent = "lookup"
            reasons.append("bounded read-only work with low ambiguity")
        else:
            agent = "explore"
            reasons.append("read-only work requires broader evidence gathering")
    elif args.kind == "write":
        if args.scope == "broad":
            agent = "orchestrator"
            reasons.append("broad writes require the orchestrator to plan and split ownership")
        else:
            agent = "build"
            reasons.append("bounded implementation fits the builder role")
            if args.validation == "independent" or args.risk == "medium":
                follow_up = "review"
                reasons.append("independent verification is required")
    elif args.kind == "review":
        agent = "review"
        reasons.append("independent correctness review fits the reviewer role")
    else:
        raise ValueError(f"unsupported task kind: {args.kind}")

    return {
        "initial_agent": agent,
        "required_follow_up": follow_up,
        "hard_gate": hard_gate,
        "classification": {
            "kind": args.kind,
            "scope": args.scope,
            "ambiguity": args.ambiguity,
            "risk": args.risk,
            "validation": args.validation,
            "flags": sorted(flags),
        },
        "reasons": reasons,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Recommend a canonical Corch role from explicit task metadata."
    )
    parser.add_argument(
        "--kind", required=True, choices=("read", "write", "review", "decision")
    )
    parser.add_argument(
        "--scope", default="single", choices=("single", "multi", "broad")
    )
    parser.add_argument(
        "--ambiguity", default="low", choices=("low", "medium", "high")
    )
    parser.add_argument(
        "--risk", default="low", choices=("low", "medium", "high", "critical")
    )
    parser.add_argument(
        "--validation", default="normal", choices=("none", "normal", "independent")
    )
    parser.add_argument(
        "--flags",
        default="",
        help="Comma-separated hard-gate flags such as security or destructive.",
    )
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()

    indent = None if args.compact else 2
    print(json.dumps(route(args), indent=indent, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
