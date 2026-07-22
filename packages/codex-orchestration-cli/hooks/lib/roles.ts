import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const fallbackPluginRoot = resolve(moduleDirectory, "..", "..", "..");
const VIRTUAL_ROLE_SCHEMA_VERSION = 5;
const ROUTING_FIELD = "task_name";
const SELECTION_MODE = "codex-native-auto";
const ROUTED_TASK_NAME_PATTERN = /^([a-z0-9]+)__([a-z0-9]+(?:_[a-z0-9]+)*)$/;
const VIRTUAL_ROLE_CONFIG_FIELDS = new Set([
  "schemaVersion",
  "routingField",
  "selectionMode",
  "roles",
]);
const VIRTUAL_ROLE_FIELDS = new Set(["description", "instructions"]);


interface VirtualRole {
  name: string;
  description: string;
  instructions: string;
}


type VirtualRoles = Readonly<Record<string, Readonly<VirtualRole>>>;


interface SpawnAgentToolInput extends Record<string, unknown> {
  task_name: string;
  message?: string;
  items?: unknown[];
  fork_turns?: string;
  model?: string;
  reasoning_effort?: string;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}


function isSpawnAgentToolInput(value: unknown): value is SpawnAgentToolInput {
  return (
    isRecord(value)
    && typeof value.task_name === "string"
    && isOptionalString(value.message)
    && (value.items === undefined || Array.isArray(value.items))
    && isOptionalString(value.fork_turns)
    && isOptionalString(value.model)
    && isOptionalString(value.reasoning_effort)
  );
}


function runtimeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const pluginRoot = resolve(environment.PLUGIN_ROOT || fallbackPluginRoot);
  return join(pluginRoot, "runtime");
}


function validateRole(name: string, role: unknown): Readonly<VirtualRole> {
  if (
    !isRecord(role)
    || typeof role.description !== "string"
    || !role.description
    || typeof role.instructions !== "string"
    || !role.instructions
    || Object.keys(role).some((field) => !VIRTUAL_ROLE_FIELDS.has(field))
  ) {
    throw new Error(`invalid virtual role: ${name}`);
  }
  return Object.freeze({
    name,
    description: role.description as string,
    instructions: role.instructions as string,
  });
}


async function loadVirtualRoleConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VirtualRoles> {
  const path = join(runtimeRoot(environment), "virtual-roles.json");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(value)
    || value.schemaVersion !== VIRTUAL_ROLE_SCHEMA_VERSION
    || value.routingField !== ROUTING_FIELD
    || value.selectionMode !== SELECTION_MODE
    || !value.roles
    || typeof value.roles !== "object"
    || Object.keys(value).some((field) => !VIRTUAL_ROLE_CONFIG_FIELDS.has(field))
  ) {
    throw new Error("unsupported virtual-role schema");
  }
  const roles = Object.freeze(
    Object.fromEntries(
      Object.entries(value.roles).map(([name, role]) => [name, validateRole(name, role)]),
    ),
  );
  return roles;
}


function resolveRole(taskName: unknown, roles: VirtualRoles): Readonly<VirtualRole> | null {
  if (typeof taskName !== "string") {
    return null;
  }
  const match = ROUTED_TASK_NAME_PATTERN.exec(taskName);
  if (!match) {
    return null;
  }
  const roleName = match[1];
  if (!roleName) {
    return null;
  }
  if (!Object.hasOwn(roles, roleName)) {
    return null;
  }
  return roles[roleName] ?? null;
}


async function roleAssignment(
  role: Readonly<VirtualRole>,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const workerContract = (
    await readFile(join(runtimeRoot(environment), "worker-contract.md"), "utf8")
  ).trim();
  return [
    "CORCH VIRTUAL ROLE ASSIGNMENT",
    `Role: ${role.name}.`,
    "Corch leaves model and reasoning effort unpinned by default so Codex can select them automatically for this task; explicit spawn overrides remain in force.",
    role.instructions,
    workerContract,
  ].join("\n\n");
}


function prependAssignment(
  toolInput: SpawnAgentToolInput,
  assignment: string,
): SpawnAgentToolInput {
  const updatedInput = {
    ...toolInput,
  };
  if (typeof toolInput.message === "string" && toolInput.message) {
    updatedInput.message = `${assignment}\n\nORIGINAL ASSIGNMENT\n${toolInput.message}`;
  } else if (Array.isArray(toolInput.items)) {
    updatedInput.items = [
      { type: "text", text: assignment },
      ...toolInput.items,
    ];
  } else {
    updatedInput.message = assignment;
  }
  return updatedInput;
}


export async function rewriteVirtualAgentInput(
  toolInput: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  role: Readonly<VirtualRole>;
  updatedInput: SpawnAgentToolInput;
} | null> {
  if (!isSpawnAgentToolInput(toolInput)) {
    return null;
  }
  const roles = await loadVirtualRoleConfig(environment);
  const role = resolveRole(toolInput.task_name, roles);
  if (!role) {
    return null;
  }
  const updatedInput = prependAssignment(
    toolInput,
    await roleAssignment(role, environment),
  );
  return { role, updatedInput };
}


export async function virtualRolePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const roles = await loadVirtualRoleConfig(environment);
  const lines = [
    "VIRTUAL WORKER ROUTING:",
    "When delegation is warranted, encode the virtual role in spawn_agent task_name as <role>__<task>, where <task> is a concise lowercase identifier using letters, digits, and underscores. Example: explore__release_changes.",
    "Corch reads and preserves task_name, then prepends the matching role contract before execution. Do not pass Corch virtual role names through agent_type.",
    "Do not set model or reasoning_effort by default. Omitting both lets Codex choose a task-appropriate balance of intelligence and speed. Preserve an explicit user request to override either setting.",
    "Use only the canonical task-oriented role names below.",
  ];
  for (const role of Object.values(roles)) {
    lines.push(
      `- ${role.name}__<task>: ${role.description} Model and reasoning: automatic.`,
    );
  }
  return lines.join("\n");
}
