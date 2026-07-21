import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";


export const SKILL_NAME = "orchestrate-codex-agents";
export const AGENT_NAMES = [
  "luna_explorer",
  "luna_fast",
  "terra_builder",
  "terra_reviewer",
];
export const START_MARKER = "<!-- orchestrate-codex-agents:start -->";
export const END_MARKER = "<!-- orchestrate-codex-agents:end -->";
const CONFIG_ASSIGNMENT_PATTERN =
  /^(\s*)((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_.-]+))(\s*=\s*)(.*)$/;


export function resolveCodexHome(explicitPath, environment = process.env) {
  const candidate = explicitPath
    || environment.CODEX_HOME
    || join(homedir(), ".codex");
  const resolved = resolve(candidate);
  if (resolved === parse(resolved).root) {
    throw new Error("refusing to use a filesystem root as CODEX_HOME");
  }
  return resolved;
}


async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}


async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}


async function updateDigest(hash, basePath, currentPath) {
  const info = await lstat(currentPath);
  const relativePath = relative(basePath, currentPath).split(sep).join("/") || ".";

  if (info.isSymbolicLink()) {
    hash.update(`link\0${relativePath}\0${await readlink(currentPath)}\0`);
    return;
  }
  if (info.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(await readFile(currentPath));
    hash.update("\0");
    return;
  }
  if (!info.isDirectory()) {
    hash.update(`other\0${relativePath}\0`);
    return;
  }

  hash.update(`dir\0${relativePath}\0`);
  const entries = await readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name === ".DS_Store") {
      continue;
    }
    await updateDigest(hash, basePath, join(currentPath, entry.name));
  }
}


export async function digestPath(path) {
  const hash = createHash("sha256");
  await updateDigest(hash, path, path);
  return hash.digest("hex");
}


function splitValueAndComment(raw) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return {
        value: raw.slice(0, index).trim(),
        comment: raw.slice(index).trimEnd(),
      };
    }
  }
  return { value: raw.trim(), comment: "" };
}


function parseDesiredConfig(snippet) {
  const desired = [];
  let section = "";
  for (const line of snippet.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) {
      throw new Error(`unsupported config snippet line: ${line}`);
    }
    desired.push({ section, key: assignment[1], value: assignment[2].trim() });
  }
  return desired;
}


function tableName(line) {
  const { value } = splitValueAndComment(line);
  const arrayTable = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  if (arrayTable) {
    return `${normalizeSimpleKey(arrayTable[1])}[]`;
  }
  const table = /^\s*\[([^\]]+)\]\s*$/.exec(value);
  return table ? normalizeSimpleKey(table[1]) : null;
}


function normalizeSimpleKey(raw) {
  const key = raw.trim();
  if (key.startsWith("'") && key.endsWith("'")) {
    return key.slice(1, -1);
  }
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key);
    } catch {
      return key;
    }
  }
  return key;
}


function tripleQuoteState(raw, currentQuote) {
  const quotes = currentQuote ? [currentQuote] : ['"""', "'''"];
  for (const quote of quotes) {
    let occurrences = 0;
    let offset = 0;
    while (true) {
      const index = raw.indexOf(quote, offset);
      if (index === -1) {
        break;
      }
      if (quote === "'''" || index === 0 || raw[index - 1] !== "\\") {
        occurrences += 1;
      }
      offset = index + quote.length;
    }
    if (occurrences % 2 === 1) {
      return currentQuote ? null : quote;
    }
  }
  return currentQuote;
}


function scanConfig(lines) {
  const sections = new Map();
  const dottedSections = new Set();
  const sectionHeaders = [];
  const assignments = [];
  let section = "";
  let multilineQuote = null;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (multilineQuote) {
      multilineQuote = tripleQuoteState(lines[index], multilineQuote);
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parsedTable = tableName(trimmed);
    if (parsedTable) {
      section = parsedTable;
      const indexes = sections.get(section) || [];
      indexes.push(index);
      sections.set(section, indexes);
      sectionHeaders.push({ section, index });
      continue;
    }
    const assignment = CONFIG_ASSIGNMENT_PATTERN.exec(lines[index]);
    if (!assignment) {
      continue;
    }
    const { value, comment } = splitValueAndComment(assignment[4]);
    const rawKey = assignment[2];
    let assignmentSection = section;
    let key = normalizeSimpleKey(rawKey);
    if (!section && !rawKey.startsWith('"') && !rawKey.startsWith("'")) {
      const separator = key.indexOf(".");
      if (separator > 0) {
        assignmentSection = key.slice(0, separator);
        key = key.slice(separator + 1);
        dottedSections.add(assignmentSection);
      }
    }
    assignments.push({
      section: assignmentSection,
      key,
      index,
      prefix: `${assignment[1]}${rawKey}${assignment[3]}`,
      value,
      comment,
    });
    multilineQuote = tripleQuoteState(value, null);
  }
  return { sections, dottedSections, sectionHeaders, assignments, multilineQuote };
}


function insertTopLevel(lines, entries) {
  if (!entries.length) {
    return;
  }
  const sectionHeaders = scanConfig(lines).sectionHeaders;
  const firstSection = sectionHeaders.length ? sectionHeaders[0].index : -1;
  let insertAt = firstSection === -1 ? lines.length : firstSection;
  while (insertAt > 0 && !lines[insertAt - 1].trim()) {
    insertAt -= 1;
  }
  const additions = entries.map(({ key, value }) => `${key} = ${value}`);
  if (firstSection !== -1) {
    additions.push("");
  }
  lines.splice(insertAt, 0, ...additions);
}


function insertSectionEntries(lines, section, entries, conflicts) {
  if (!entries.length) {
    return;
  }
  const scan = scanConfig(lines);
  const sectionIndexes = scan.sections.get(section) || [];
  if (sectionIndexes.length > 1) {
    conflicts.push(`config.toml contains duplicate [${section}] sections`);
    return;
  }
  if (!sectionIndexes.length) {
    if (lines.length && lines.at(-1).trim()) {
      lines.push("");
    }
    lines.push(`[${section}]`, ...entries.map(({ key, value }) => `${key} = ${value}`));
    return;
  }

  const sectionStart = sectionIndexes[0];
  const nextSection = scan.sectionHeaders.find((header) => header.index > sectionStart);
  let sectionEnd = nextSection ? nextSection.index : lines.length;
  while (sectionEnd > sectionStart + 1 && !lines[sectionEnd - 1].trim()) {
    sectionEnd -= 1;
  }
  lines.splice(
    sectionEnd,
    0,
    ...entries.map(({ key, value }) => `${key} = ${value}`),
    ...(sectionEnd < lines.length ? [""] : []),
  );
}


export function mergeConfig(existing, snippet, force = false) {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const desired = parseDesiredConfig(snippet);
  const conflicts = [];
  const missing = [];
  let changed = false;
  const initialScan = scanConfig(lines);

  if (initialScan.multilineQuote) {
    conflicts.push("config.toml contains an unterminated multiline string");
  }
  if (
    initialScan.assignments.some((assignment) =>
      assignment.section === ""
      && assignment.key === "agents"
      && assignment.value.startsWith("{"),
    )
  ) {
    conflicts.push("config.toml uses an inline agents table that cannot be merged safely");
  }
  if (
    initialScan.sections.has("agents")
    && initialScan.dottedSections.has("agents")
  ) {
    conflicts.push("config.toml mixes [agents] with top-level agents.* assignments");
  }

  for (const entry of desired) {
    const matches = initialScan.assignments.filter(
      (assignment) => assignment.section === entry.section && assignment.key === entry.key,
    );
    if (matches.length > 1) {
      const location = entry.section ? `[${entry.section}].${entry.key}` : entry.key;
      conflicts.push(`config.toml contains duplicate ${location} assignments`);
      continue;
    }
    if (!matches.length) {
      missing.push(entry);
      changed = true;
      continue;
    }

    const current = matches[0];
    if (current.value === entry.value) {
      continue;
    }
    const location = entry.section ? `[${entry.section}].${entry.key}` : entry.key;
    if (!force) {
      conflicts.push(
        `config.toml ${location} is ${current.value}; expected ${entry.value}`,
      );
      continue;
    }
    const comment = current.comment ? ` ${current.comment}` : "";
    lines[current.index] = `${current.prefix}${entry.value}${comment}`;
    changed = true;
  }

  insertTopLevel(
    lines,
    missing.filter((entry) => !entry.section),
  );
  const sections = [...new Set(missing.map((entry) => entry.section).filter(Boolean))];
  for (const section of sections) {
    const entries = missing.filter((entry) => entry.section === section);
    const currentScan = scanConfig(lines);
    if (!currentScan.sections.has(section) && currentScan.dottedSections.has(section)) {
      insertTopLevel(
        lines,
        entries.map((entry) => ({ ...entry, key: `${section}.${entry.key}` })),
      );
    } else {
      insertSectionEntries(lines, section, entries, conflicts);
    }
  }

  if (conflicts.length) {
    return { text: existing, conflicts, changed: false };
  }
  const text = lines.length ? `${lines.join(newline)}${newline}` : "";
  return { text, conflicts, changed: changed && text !== existing };
}


export function renderManagedPolicy(existing, snippet) {
  const startCount = existing.split(START_MARKER).length - 1;
  const endCount = existing.split(END_MARKER).length - 1;
  if (startCount !== endCount || startCount > 1) {
    throw new Error("AGENTS.md managed-block markers are missing or duplicated");
  }

  if (startCount === 1) {
    const startIndex = existing.indexOf(START_MARKER);
    const endMarkerIndex = existing.indexOf(END_MARKER, startIndex);
    if (endMarkerIndex < startIndex) {
      throw new Error("AGENTS.md managed-block markers are out of order");
    }
    const endIndex = endMarkerIndex + END_MARKER.length;
    const prefix = existing.slice(0, startIndex).trimEnd();
    const suffix = existing.slice(endIndex);
    const separator = prefix ? "\n\n" : "";
    return `${prefix}${separator}${snippet.trim()}${suffix}`;
  }
  if (!existing.trim()) {
    return `${snippet.trim()}\n`;
  }
  return `${existing.trimEnd()}\n\n${snippet.trim()}\n`;
}


function assertInside(base, target) {
  const relativePath = relative(base, target);
  if (
    !relativePath
    || relativePath.startsWith(`..${sep}`)
    || relativePath === ".."
    || isAbsolute(relativePath)
  ) {
    throw new Error(`unsafe target outside CODEX_HOME: ${target}`);
  }
}


async function addCopyPlan(plan, { label, source, target, force }) {
  const targetInfo = await pathInfo(target);
  if (!targetInfo) {
    plan.operations.push({ action: "create", kind: "copy", label, source, target });
    return;
  }
  const sourceDigest = await digestPath(source);
  const targetDigest = await digestPath(target);
  if (sourceDigest === targetDigest) {
    plan.current.push({ label, target });
  } else if (force) {
    plan.operations.push({ action: "replace", kind: "copy", label, source, target });
  } else {
    plan.conflicts.push({ label, target, reason: "existing content differs" });
  }
}


async function addWritePlan(plan, { label, content, target }) {
  const targetInfo = await pathInfo(target);
  if (!targetInfo) {
    plan.operations.push({ action: "create", kind: "write", label, content, target });
    return;
  }
  if (!targetInfo.isFile()) {
    plan.conflicts.push({ label, target, reason: "target is not a regular file" });
    return;
  }
  const existing = await readFile(target, "utf8");
  if (existing === content) {
    plan.current.push({ label, target });
  } else {
    plan.operations.push({ action: "update", kind: "write", label, content, target });
  }
}


export async function createSetupPlan({
  codexHome,
  payloadRoot,
  force = false,
  skipPolicy = false,
  skipConfig = false,
}) {
  const resolvedHome = resolveCodexHome(codexHome);
  const resolvedPayload = resolve(payloadRoot);
  const plan = {
    codexHome: resolvedHome,
    payloadRoot: resolvedPayload,
    current: [],
    operations: [],
    conflicts: [],
  };

  const skillFile = join(resolvedPayload, "SKILL.md");
  if (!(await pathInfo(skillFile))) {
    throw new Error(`skill payload is missing: ${skillFile}`);
  }

  await addCopyPlan(plan, {
    label: `skill ${SKILL_NAME}`,
    source: resolvedPayload,
    target: join(resolvedHome, "skills", SKILL_NAME),
    force,
  });

  for (const agentName of AGENT_NAMES) {
    await addCopyPlan(plan, {
      label: `agent ${agentName}`,
      source: join(resolvedPayload, "assets", "agents", `${agentName}.toml`),
      target: join(resolvedHome, "agents", `${agentName}.toml`),
      force,
    });
  }

  if (!skipPolicy) {
    const policyTarget = join(resolvedHome, "AGENTS.md");
    const existingPolicy = await readOptional(policyTarget);
    const policySnippet = await readFile(
      join(resolvedPayload, "assets", "AGENTS.snippet.md"),
      "utf8",
    );
    try {
      const renderedPolicy = renderManagedPolicy(existingPolicy, policySnippet);
      await addWritePlan(plan, {
        label: "managed AGENTS.md policy",
        target: policyTarget,
        content: renderedPolicy,
      });
    } catch (error) {
      plan.conflicts.push({
        label: "managed AGENTS.md policy",
        target: policyTarget,
        reason: error.message,
      });
    }
  }

  if (!skipConfig) {
    const configTarget = join(resolvedHome, "config.toml");
    const existingConfig = await readOptional(configTarget);
    const configSnippet = await readFile(
      join(resolvedPayload, "assets", "config.snippet.toml"),
      "utf8",
    );
    const mergedConfig = mergeConfig(existingConfig, configSnippet, force);
    for (const reason of mergedConfig.conflicts) {
      plan.conflicts.push({ label: "Codex configuration", target: configTarget, reason });
    }
    if (!mergedConfig.conflicts.length) {
      await addWritePlan(plan, {
        label: "Codex configuration",
        target: configTarget,
        content: mergedConfig.text,
      });
    }
  }

  for (const operation of plan.operations) {
    assertInside(resolvedHome, operation.target);
  }
  return plan;
}


function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[-:.]/g, "");
}


async function availableBackupPath(target) {
  const base = `${target}.bak-${backupStamp()}`;
  let candidate = base;
  let suffix = 1;
  while (await pathInfo(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}


async function copyOperation(operation) {
  const sourceInfo = await stat(operation.source);
  if (sourceInfo.isDirectory()) {
    await cp(operation.source, operation.target, { recursive: true });
    return;
  }
  await copyFile(operation.source, operation.target);
  await chmod(operation.target, sourceInfo.mode & 0o777);
}


async function removeTarget(target) {
  await rm(target, { recursive: true, force: true });
}


export async function applySetupPlan(plan) {
  if (plan.conflicts.length) {
    throw new Error("cannot apply a setup plan that contains conflicts");
  }

  const applied = [];
  try {
    for (const operation of plan.operations) {
      assertInside(plan.codexHome, operation.target);
      await mkdir(dirname(operation.target), { recursive: true });
      const existingInfo = await pathInfo(operation.target);
      const backup = existingInfo ? await availableBackupPath(operation.target) : null;
      if (backup) {
        await rename(operation.target, backup);
      }

      try {
        if (operation.kind === "copy") {
          await copyOperation(operation);
        } else {
          await writeFile(operation.target, operation.content, "utf8");
          if (existingInfo?.isFile()) {
            await chmod(operation.target, existingInfo.mode & 0o777);
          }
        }
      } catch (error) {
        await removeTarget(operation.target);
        if (backup) {
          await rename(backup, operation.target);
        }
        throw error;
      }
      applied.push({ operation, backup });
    }
  } catch (error) {
    for (const { operation, backup } of applied.reverse()) {
      await removeTarget(operation.target);
      if (backup) {
        await rename(backup, operation.target);
      }
    }
    throw error;
  }
  return applied;
}


export function formatPlan(plan) {
  const lines = [`Codex home: ${plan.codexHome}`];
  for (const item of plan.current) {
    lines.push(`CURRENT  ${item.label}: ${item.target}`);
  }
  for (const operation of plan.operations) {
    const action = operation.action.toUpperCase().padEnd(7);
    lines.push(`${action}  ${operation.label}: ${operation.target}`);
  }
  for (const conflict of plan.conflicts) {
    lines.push(`CONFLICT ${conflict.label}: ${conflict.target} (${conflict.reason})`);
  }
  return lines.join("\n");
}
