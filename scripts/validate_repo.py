#!/usr/bin/env python3
"""Validate every self-contained skill in this repository."""

import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import unquote, urlsplit


NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
REQUIRED_AGENT_FIELDS = ("display_name", "short_description", "default_prompt")


def parse_frontmatter(text: str) -> Tuple[Dict[str, str], str, List[str]]:
    errors: List[str] = []
    if not text.startswith("---\n"):
        return {}, text, ["SKILL.md must start with YAML frontmatter"]

    closing = text.find("\n---\n", 4)
    if closing == -1:
        return {}, text, ["SKILL.md frontmatter is not closed"]

    raw_frontmatter = text[4:closing]
    body = text[closing + 5 :]
    fields: Dict[str, str] = {}
    for line_number, line in enumerate(raw_frontmatter.splitlines(), start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line or line[:1].isspace():
            errors.append(f"unsupported frontmatter syntax on line {line_number}")
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip('"\'')

    return fields, body, errors


def validate_frontmatter(skill_dir: Path, skill_file: Path) -> List[str]:
    skill_text = skill_file.read_text(encoding="utf-8")
    fields, body, errors = parse_frontmatter(skill_text)
    keys = set(fields)
    if keys != {"name", "description"}:
        errors.append("frontmatter must contain exactly name and description")

    name = fields.get("name", "")
    if name != skill_dir.name:
        errors.append(f"frontmatter name {name!r} must match directory {skill_dir.name!r}")
    if len(name) > 64 or not NAME_RE.fullmatch(name):
        errors.append(
            "name must be at most 64 lowercase letters, digits, or "
            "hyphen-separated words"
        )
    if not fields.get("description"):
        errors.append("description must not be empty")
    if not body.strip():
        errors.append("SKILL.md body must not be empty")
    if "TODO" in skill_text:
        errors.append("SKILL.md contains TODO")
    return errors


def validate_agent_metadata(skill_dir: Path) -> List[str]:
    metadata = skill_dir / "agents" / "openai.yaml"
    if not metadata.is_file():
        return ["agents/openai.yaml is missing"]

    text = metadata.read_text(encoding="utf-8")
    errors: List[str] = []
    if not re.search(r"^interface:\s*$", text, re.MULTILINE):
        errors.append("agents/openai.yaml is missing the interface mapping")
    for field in REQUIRED_AGENT_FIELDS:
        field_pattern = rf"^\s{{2}}{field}:\s*\S.+$"
        if not re.search(field_pattern, text, re.MULTILINE):
            errors.append(f"agents/openai.yaml is missing interface.{field}")
    if f"${skill_dir.name}" not in text:
        errors.append("interface.default_prompt must mention the skill with $skill-name")
    return errors


def link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        return target[1 : target.index(">")]
    parts = target.split(maxsplit=1)
    return parts[0] if parts else ""


def validate_links(skill_dir: Path) -> List[str]:
    errors: List[str] = []
    for markdown in skill_dir.rglob("*.md"):
        text = markdown.read_text(encoding="utf-8")
        for match in LINK_RE.finditer(text):
            raw_target = link_target(match.group(1))
            parsed = urlsplit(raw_target)
            if parsed.scheme or parsed.netloc or raw_target.startswith(("#", "/")):
                continue
            relative_path = unquote(parsed.path)
            if not relative_path:
                continue
            resolved = (markdown.parent / relative_path).resolve()
            if not resolved.exists():
                errors.append(f"broken link in {markdown.relative_to(skill_dir)}: {raw_target}")
    return errors


def validate_python(skill_dir: Path) -> List[str]:
    errors: List[str] = []
    for source_path in skill_dir.rglob("*.py"):
        try:
            source = source_path.read_text(encoding="utf-8")
            compile(source, str(source_path), "exec")
        except (OSError, SyntaxError, UnicodeError) as error:
            errors.append(f"cannot compile {source_path.relative_to(skill_dir)}: {error}")
    return errors


def validate_script_modes(skill_dir: Path) -> List[str]:
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.is_dir():
        return []
    return [
        f"script is not executable: {path.relative_to(skill_dir)}"
        for path in sorted(scripts_dir.rglob("*"))
        if path.is_file() and not path.stat().st_mode & 0o111
    ]


def validate_skill(skill_dir: Path) -> List[str]:
    skill_file = skill_dir / "SKILL.md"
    errors = validate_frontmatter(skill_dir, skill_file)
    errors.extend(validate_agent_metadata(skill_dir))
    errors.extend(validate_links(skill_dir))
    errors.extend(validate_python(skill_dir))
    errors.extend(validate_script_modes(skill_dir))
    return errors


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    skills_root = repo_root / "skills"
    skill_dirs = sorted(path.parent for path in skills_root.glob("*/SKILL.md"))
    if not skill_dirs:
        print("ERROR: no skills/*/SKILL.md files found", file=sys.stderr)
        return 1

    failures = 0
    for skill_dir in skill_dirs:
        errors = validate_skill(skill_dir)
        if errors:
            failures += len(errors)
            for error in errors:
                print(f"ERROR [{skill_dir.name}]: {error}", file=sys.stderr)
        else:
            print(f"OK: {skill_dir.name}")

    if failures:
        print(f"FAILED: {failures} validation error(s)", file=sys.stderr)
        return 1

    print(f"Validated {len(skill_dirs)} skill(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
