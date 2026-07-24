import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";


export const MODES = ["off", "lite", "full", "ultra"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "full";


export interface WorkerObservation {
  schemaVersion: 1;
  recordedAt: string;
  agentId: string;
  agentType: string;
  model: string;
  turnId: string;
}


export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && MODES.includes(value as Mode);
}


export function resolveCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolve(environment.CODEX_HOME || join(homedir(), ".codex"));
  if (resolved === parse(resolved).root) {
    throw new Error("refusing to use a filesystem root as CODEX_HOME");
  }
  return resolved;
}


export function pluginDataRoot(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (!environment.PLUGIN_DATA) {
    return null;
  }
  const resolved = resolve(environment.PLUGIN_DATA);
  if (resolved === parse(resolved).root) {
    throw new Error("refusing to use a filesystem root as PLUGIN_DATA");
  }
  return resolved;
}


export function legacyConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodexHome(environment), "orchestration", "config.json");
}


export function configPath(environment: NodeJS.ProcessEnv = process.env): string {
  const dataRoot = pluginDataRoot(environment);
  return dataRoot ? join(dataRoot, "config.json") : legacyConfigPath(environment);
}


function sessionDigest(sessionId: unknown): string {
  return createHash("sha256")
    .update(String(sessionId || "unknown-session"))
    .digest("hex");
}


function sessionFile(
  sessionId: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const dataRoot = pluginDataRoot(environment);
  if (!dataRoot) {
    return null;
  }
  return join(dataRoot, "sessions", `${sessionDigest(sessionId)}.json`);
}


function workerObservationsFile(
  sessionId: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const dataRoot = pluginDataRoot(environment);
  return dataRoot
    ? join(dataRoot, "worker-observations", `${sessionDigest(sessionId)}.jsonl`)
    : null;
}


function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}


function isWorkerObservation(value: unknown): value is WorkerObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const observation = value as Partial<WorkerObservation>;
  return observation.schemaVersion === 1
    && isNonEmptyString(observation.recordedAt)
    && isNonEmptyString(observation.agentId)
    && isNonEmptyString(observation.agentType)
    && isNonEmptyString(observation.model)
    && isNonEmptyString(observation.turnId);
}


async function readJson(path: string | null): Promise<Record<string, unknown> | null> {
  if (!path) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}


async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The hook is fail-open; preserve the original error for the caller.
    }
    throw error;
  }
}


export async function readDefaultMode(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Mode> {
  const override = environment.CODEX_ORCHESTRATION_DEFAULT_MODE;
  if (isMode(override)) {
    return override;
  }
  const config = await readJson(configPath(environment));
  if (isMode(config?.defaultMode)) {
    return config.defaultMode;
  }
  if (pluginDataRoot(environment)) {
    const legacy = await readJson(legacyConfigPath(environment));
    if (isMode(legacy?.defaultMode)) {
      return legacy.defaultMode;
    }
  }
  return DEFAULT_MODE;
}


export async function writeDefaultMode(
  mode: Mode,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isMode(mode)) {
    throw new Error(`unsupported orchestration mode: ${mode}`);
  }
  await atomicWriteJson(configPath(environment), {
    schemaVersion: 1,
    defaultMode: mode,
    updatedAt: new Date().toISOString(),
  });
}


export async function readSessionMode(
  sessionId: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Mode | null> {
  const state = await readJson(sessionFile(sessionId, environment));
  return isMode(state?.mode) ? state.mode : null;
}


export async function writeSessionMode(
  sessionId: unknown,
  mode: Mode,
  environment: NodeJS.ProcessEnv = process.env,
  source = "command",
): Promise<void> {
  if (!isMode(mode)) {
    throw new Error(`unsupported orchestration mode: ${mode}`);
  }
  const path = sessionFile(sessionId, environment);
  if (!path) {
    return;
  }
  await atomicWriteJson(path, {
    schemaVersion: 1,
    mode,
    source,
    updatedAt: new Date().toISOString(),
  });
}


export async function recordWorkerObservation(
  sessionId: unknown,
  observation: Omit<WorkerObservation, "schemaVersion" | "recordedAt">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const path = workerObservationsFile(sessionId, environment);
  if (!path) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record: WorkerObservation = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ...observation,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}


export async function readWorkerObservations(
  sessionId: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  limit = 5,
): Promise<WorkerObservation[]> {
  const path = workerObservationsFile(sessionId, environment);
  if (!path) {
    return [];
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const observations: WorkerObservation[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isWorkerObservation(value)) {
        observations.push(value);
      }
    } catch {
      // A partial or corrupt line must not hide otherwise valid observations.
    }
  }
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 5;
  const boundedLimit = Math.min(Math.max(normalizedLimit, 0), 20);
  return boundedLimit === 0
    ? []
    : observations.slice(-boundedLimit).reverse();
}
