#!/usr/bin/env python3
"""Install portable agent templates and a managed AGENTS.md policy block."""

import argparse
import os
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional


START_MARKER = "<!-- orchestrate-codex-agents:start -->"
END_MARKER = "<!-- orchestrate-codex-agents:end -->"


@dataclass
class Operation:
    action: str
    target: Path
    content: Optional[str] = None
    source: Optional[Path] = None
    backup: bool = False
    skip: bool = False


def default_codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def backup_path(path: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return path.with_name(f"{path.name}.bak-{stamp}")


def rendered_agents(existing: str, snippet: str) -> str:
    has_start = START_MARKER in existing
    has_end = END_MARKER in existing
    if has_start != has_end:
        raise ValueError("AGENTS.md contains only one managed-block marker")

    if has_start:
        prefix, remainder = existing.split(START_MARKER, 1)
        _, suffix = remainder.split(END_MARKER, 1)
        preserved_prefix = prefix.rstrip()
        separator = "\n\n" if preserved_prefix else ""
        return preserved_prefix + separator + snippet.strip() + suffix

    if not existing.strip():
        return snippet.strip() + "\n"
    return existing.rstrip() + "\n\n" + snippet.strip() + "\n"


def plan_install(codex_home: Path, force: bool) -> List[Operation]:
    skill_root = Path(__file__).resolve().parents[1]
    source_agents = skill_root / "assets" / "agents"
    snippet = (skill_root / "assets" / "AGENTS.snippet.md").read_text(encoding="utf-8")
    target_agents = codex_home / "agents"
    operations: List[Operation] = []
    conflicts: List[Path] = []

    for source in sorted(source_agents.glob("*.toml")):
        target = target_agents / source.name
        if not target.exists():
            operations.append(Operation("install agent", target, source=source))
        elif target.read_bytes() == source.read_bytes():
            operations.append(Operation("agent already current", target, skip=True))
        elif force:
            operations.append(Operation("replace agent", target, source=source, backup=True))
        else:
            conflicts.append(target)

    agents_md = codex_home / "AGENTS.md"
    existing = agents_md.read_text(encoding="utf-8") if agents_md.exists() else ""
    updated = rendered_agents(existing, snippet)
    if updated == existing:
        operations.append(Operation("policy already current", agents_md, skip=True))
    elif START_MARKER in existing and not force:
        conflicts.append(agents_md)
    else:
        operations.append(
            Operation(
                "update policy" if agents_md.exists() else "install policy",
                agents_md,
                content=updated,
                backup=agents_md.exists(),
            )
        )

    if conflicts:
        joined = "\n".join(f"  - {path}" for path in conflicts)
        raise RuntimeError(
            "existing files differ from the portable policy; inspect them or rerun "
            f"with --force to create backups and replace managed content:\n{joined}"
        )

    return operations


def apply_operations(operations: List[Operation], dry_run: bool) -> None:
    for operation in operations:
        print(f"{operation.action}: {operation.target}")
        if dry_run or operation.skip:
            continue

        operation.target.parent.mkdir(parents=True, exist_ok=True)
        if operation.backup and operation.target.exists():
            destination = backup_path(operation.target)
            shutil.copy2(operation.target, destination)
            print(f"backup: {destination}")

        if operation.source is not None:
            shutil.copy2(operation.source, operation.target)
        elif operation.content is not None:
            operation.target.write_text(operation.content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install Sol/Terra/Luna custom agents and managed global guidance."
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=default_codex_home(),
        help="Target Codex home directory (default: CODEX_HOME or ~/.codex).",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Back up and replace differing agent files or managed policy content.",
    )
    args = parser.parse_args()
    codex_home = args.codex_home.expanduser().resolve()

    try:
        operations = plan_install(codex_home, args.force)
    except (RuntimeError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    apply_operations(operations, args.dry_run)
    config_snippet = Path(__file__).resolve().parents[1] / "assets" / "config.snippet.toml"
    print(f"merge manually into config.toml: {config_snippet}")
    print("start a new Codex task after installation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
