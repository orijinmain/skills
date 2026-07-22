#!/usr/bin/env python3
"""Validate the skill catalog and detachable orchestration plugin."""

import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import unquote, urlsplit


NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
REQUIRED_AGENT_FIELDS = ("display_name", "short_description", "default_prompt")
EXPECTED_SKILLS = {"corch"}
EXPLICIT_ONLY_SKILLS = EXPECTED_SKILLS


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
    if skill_dir.name in EXPLICIT_ONLY_SKILLS and not re.search(
        r"^policy:\s*\n\s{2}allow_implicit_invocation:\s*false\s*$",
        text,
        re.MULTILINE,
    ):
        errors.append("orchestration skills must disable implicit invocation")
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


def load_json(path: Path, errors: List[str]) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"missing required JSON file: {path}")
    except json.JSONDecodeError as error:
        errors.append(f"invalid JSON in {path}: {error}")
    return {}


def validate_plugin(repo_root: Path) -> List[str]:
    errors: List[str] = []
    package_root = repo_root / "packages" / "codex-orchestration-cli"
    package = load_json(package_root / "package.json", errors)
    manifest = load_json(package_root / ".codex-plugin" / "plugin.json", errors)
    marketplace = load_json(repo_root / ".agents" / "plugins" / "marketplace.json", errors)
    hooks = load_json(package_root / "hooks" / "hooks.json", errors)

    if not all(isinstance(value, dict) for value in (package, manifest, marketplace, hooks)):
        return errors
    if package.get("version") != "0.2.0" or manifest.get("version") != "0.2.0":
        errors.append("package and plugin manifest versions must both be 0.2.0")
    if package.get("name") != "@orijinmain/corch":
        errors.append("unexpected npm package name")
    if package.get("bin") != {"corch": "dist/bin/codex-orchestration.js"}:
        errors.append("unexpected CLI binary mapping")
    if manifest.get("name") != "codex-orchestration":
        errors.append("unexpected plugin name")
    if "hooks" in manifest:
        errors.append("plugin manifest must use default hook discovery, not a hooks field")
    if manifest.get("skills") != "./skills/":
        errors.append("plugin manifest must discover ./skills/")

    packaged_files = set(package.get("files", []))
    for expected in (
        ".codex-plugin/",
        "dist/bin/",
        "dist/hooks/",
        "dist/src/",
        "hooks/hooks.json",
        "runtime/",
        "schemas/codex-hooks/LICENSE.openai-codex",
        "schemas/codex-hooks/README.md",
        "skills/",
    ):
        if expected not in packaged_files:
            errors.append(f"package files is missing {expected}")

    if marketplace.get("name") != "orijinmain-skills":
        errors.append("unexpected marketplace name")
    if marketplace.get("interface", {}).get("displayName") != "orijinmain Skills":
        errors.append("unexpected marketplace display name")
    entries = marketplace.get("plugins", [])
    entry = next(
        (item for item in entries if item.get("name") == "codex-orchestration"),
        None,
    )
    expected_source = {
        "source": "npm",
        "package": "@orijinmain/corch",
        "version": "^0.2.0",
        "registry": "https://registry.npmjs.org",
    }
    if not entry or entry.get("source") != expected_source:
        errors.append("marketplace npm source is missing or incorrect")
    elif entry.get("policy") != {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    } or entry.get("category") != "Productivity":
        errors.append("marketplace policy or category is incorrect")

    hook_events = hooks.get("hooks", {})
    for event in ("PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"):
        if event not in hook_events:
            errors.append(f"hooks/hooks.json is missing {event}")
    for script in (
        "pre-tool-use.ts",
        "session-start.ts",
        "subagent-start.ts",
        "user-prompt-submit.ts",
    ):
        if not (package_root / "hooks" / script).is_file():
            errors.append(f"missing TypeScript hook entrypoint: hooks/{script}")
    for groups in hook_events.values():
        for group in groups:
            for hook in group.get("hooks", []):
                if hook.get("timeout") != 5:
                    errors.append("all hook commands must have a five-second timeout")
                if not str(hook.get("command", "")).endswith("|| true"):
                    errors.append("POSIX hook commands must fail open")
                windows = str(hook.get("commandWindows", ""))
                if "powershell" in windows.lower() or "$env:PLUGIN_ROOT" not in windows:
                    errors.append("Windows hook commands must run directly in the host PowerShell")

    source_skill = repo_root / "skills" / "corch"
    runtime_root = repo_root / "runtime"
    if not (source_skill / "SKILL.md").is_file():
        errors.append("missing Corch skill: skills/corch")
    else:
        skill_text = (source_skill / "SKILL.md").read_text(encoding="utf-8")
        if "$corch status" not in skill_text or "corch status" not in skill_text:
            errors.append("Corch skill must document native and fallback controls")
    build_script = (package_root / "scripts" / "build-payload.ts").read_text(
        encoding="utf-8"
    )
    if 'skillName = "corch"' not in build_script:
        errors.append("package build does not include the Corch skill")
    if 'join(repositoryRoot, "runtime")' not in build_script:
        errors.append("package build does not include internal runtime resources")
    if not (package_root / "tsconfig.json").is_file():
        errors.append("missing TypeScript configuration")
    schema_root = package_root / "schemas" / "codex-hooks"
    schema_release_root = schema_root / "rust-v0.144.5"
    schema_events = (
        "session-start",
        "subagent-start",
        "pre-tool-use",
        "user-prompt-submit",
    )
    for metadata_file in ("README.md", "LICENSE.openai-codex"):
        if not (schema_root / metadata_file).is_file():
            errors.append(f"missing vendored Codex schema metadata: {metadata_file}")
    for event in schema_events:
        for direction in ("input", "output"):
            schema_name = f"{event}.command.{direction}.schema.json"
            schema = load_json(schema_release_root / schema_name, errors)
            if not isinstance(schema, dict):
                continue
            if schema.get("$schema") != "http://json-schema.org/draft-07/schema#":
                errors.append(f"unexpected JSON Schema draft in {schema_name}")
            if schema.get("additionalProperties") is not False:
                errors.append(f"Codex schema must reject undeclared properties: {schema_name}")
    generated_types = {
        "session-start-input.ts",
        "session-start-output.ts",
        "subagent-start-input.ts",
        "subagent-start-output.ts",
        "pre-tool-use-input.ts",
        "pre-tool-use-output.ts",
        "user-prompt-submit-input.ts",
        "user-prompt-submit-output.ts",
    }
    generated_root = package_root / "hooks" / "generated"
    missing_generated_types = {
        name for name in generated_types if not (generated_root / name).is_file()
    }
    if missing_generated_types:
        errors.append(
            "missing generated Codex hook types: "
            + ", ".join(sorted(missing_generated_types))
        )
    scripts = package.get("scripts", {})
    if "rust-v0.144.5" not in scripts.get("generate:hook-types", ""):
        errors.append("hook type generation must use the pinned Codex schema release")
    if "generate:hook-types" not in scripts.get("prebuild", ""):
        errors.append("package build must regenerate Codex hook types")
    if package.get("devDependencies", {}).get("json-schema-to-typescript") != "^15.0.4":
        errors.append("unexpected Codex hook type generator dependency")
    if not (package_root / "hooks" / "lib" / "schema.ts").is_file():
        errors.append("missing Codex hook runtime schema boundary")
    javascript_sources = [
        path
        for directory in ("bin", "hooks", "scripts", "src", "test")
        for path in (package_root / directory).rglob("*.js")
    ]
    if javascript_sources:
        errors.append("authored JavaScript sources remain outside dist")
    for reference in (
        "core-policy.md",
        "mode-lite.md",
        "mode-full.md",
        "mode-ultra.md",
        "routing-policy.md",
        "virtual-roles.json",
        "worker-contract.md",
    ):
        if not (runtime_root / reference).is_file():
            errors.append(f"missing canonical policy reference: {reference}")
    core_policy = (runtime_root / "core-policy.md").read_text(
        encoding="utf-8"
    )
    if "canonical `orchestrator`" not in core_policy:
        errors.append("core policy must define orchestrator as the canonical root role")
    route_script = (runtime_root / "scripts" / "route_task.py").read_text(
        encoding="utf-8"
    )
    uses_canonical_root = 'agent = "orchestrator"' in route_script
    if not uses_canonical_root:
        errors.append("deterministic routing must use the orchestrator root role")
    handoff_script = (runtime_root / "scripts" / "validate_handoff.py").read_text(
        encoding="utf-8"
    )
    supports_canonical_root = '"orchestrator"' in handoff_script
    if not supports_canonical_root:
        errors.append("handoffs must support the orchestrator root role")
    virtual_roles = load_json(
        runtime_root / "virtual-roles.json",
        errors,
    )
    expected_roles = {"lookup", "explore", "build", "review"}
    virtual_roles = virtual_roles if isinstance(virtual_roles, dict) else {}
    roles = virtual_roles.get("roles", {})
    if virtual_roles.get("schemaVersion") != 5:
        errors.append("virtual roles must use schemaVersion 5")
    if virtual_roles.get("routingField") != "task_name":
        errors.append("virtual roles must route through task_name")
    if virtual_roles.get("selectionMode") != "codex-native-auto":
        errors.append("virtual roles must use Codex-native automatic worker selection")
    if set(virtual_roles) != {"schemaVersion", "routingField", "selectionMode", "roles"}:
        errors.append("virtual-role configuration contains unsupported top-level fields")
    if not isinstance(roles, dict) or set(roles) != expected_roles:
        errors.append("virtual roles must define exactly lookup, explore, build, and review")
        roles = roles if isinstance(roles, dict) else {}
    for role_name in expected_roles:
        role = roles.get(role_name, {})
        if not isinstance(role, dict):
            errors.append(f"virtual role {role_name} must be an object")
            continue
        unsupported_fields = set(role).difference({"description", "instructions"})
        if unsupported_fields:
            errors.append(
                f"virtual role {role_name} contains unsupported fields: "
                f"{sorted(unsupported_fields)}"
            )
    errors.extend(validate_python(runtime_root))
    errors.extend(validate_script_modes(runtime_root))
    return errors


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    skills_root = repo_root / "skills"
    skill_dirs = sorted(path.parent for path in skills_root.glob("*/SKILL.md"))
    if not skill_dirs:
        print("ERROR: no skills/*/SKILL.md files found", file=sys.stderr)
        return 1
    missing_skills = EXPECTED_SKILLS.difference(path.name for path in skill_dirs)
    if missing_skills:
        print(
            f"ERROR: missing required skills: {', '.join(sorted(missing_skills))}",
            file=sys.stderr,
        )
        return 1
    unexpected_skills = {path.name for path in skill_dirs}.difference(EXPECTED_SKILLS)
    if unexpected_skills:
        print(
            f"ERROR: unexpected skills: {', '.join(sorted(unexpected_skills))}",
            file=sys.stderr,
        )
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

    plugin_errors = validate_plugin(repo_root)
    if plugin_errors:
        failures += len(plugin_errors)
        for error in plugin_errors:
            print(f"ERROR [codex-orchestration plugin]: {error}", file=sys.stderr)
    else:
        print("OK: codex-orchestration plugin")

    if failures:
        print(f"FAILED: {failures} validation error(s)", file=sys.stderr)
        return 1

    print(f"Validated {len(skill_dirs)} skill(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
