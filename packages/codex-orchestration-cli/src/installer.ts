import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);

export const MODES = ["off", "lite", "full", "ultra"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "full";
export const PLUGIN_ID = "codex-orchestration@orijinmain-skills";
export const MARKETPLACE_NAME = "orijinmain-skills";
export const MARKETPLACE_SOURCE = "https://github.com/orijinmain/skills.git";
export const PLUGIN_DATA_DIRECTORY = "codex-orchestration-orijinmain-skills";
const RECEIPT_SCHEMA_VERSION = 2;


type JsonRecord = Record<string, unknown>;
type FileInspectionType = "missing" | "symlink" | "non-file" | "file";


interface FileInspection {
  value: unknown;
  error: string | null;
  type: FileInspectionType;
  digest: string | null;
}


interface OwnedReceipt extends JsonRecord {
  pluginId: typeof PLUGIN_ID;
  marketplace: typeof MARKETPLACE_NAME;
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
}


interface OwnedModeConfig extends JsonRecord {
  schemaVersion: 1;
  defaultMode: Mode;
}


export interface PlanItem {
  label: string;
  target: string;
}


interface OperationBase extends PlanItem {
  action: "create" | "update" | "remove";
  target: string;
}


interface WriteOperation extends OperationBase {
  kind: "write";
  content: string;
  expectedType: "missing" | "file";
  expectedDigest?: string | null;
}


interface CopyOperation extends OperationBase {
  kind: "copy";
  source: string;
  expectedType: "missing" | "file";
  expectedDigest?: string | null;
}


interface RemoveFileOperation extends OperationBase {
  action: "remove";
  kind: "remove";
  expectedType: "file";
  expectedDigest: string | null;
}


interface RemoveDirectoryOperation extends OperationBase {
  action: "remove";
  kind: "remove";
  expectedType: "directory";
  expectedDevice: number;
  expectedInode: number;
}


export type SetupOperation = WriteOperation | CopyOperation | RemoveFileOperation;
export type UninstallOperation = RemoveFileOperation | RemoveDirectoryOperation;


export interface SetupPlan {
  codexHome: string;
  defaultMode: Mode;
  current: PlanItem[];
  operations: SetupOperation[];
  warnings: string[];
  conflicts: string[];
}


export interface UninstallPlan {
  codexHome: string;
  operations: UninstallOperation[];
  current: PlanItem[];
  warnings: string[];
}


export interface CodexCommandResult {
  stdout: string;
  stderr: string;
}


export interface CodexClient {
  run(args: string[]): Promise<CodexCommandResult>;
}


export interface PluginEntry extends JsonRecord {
  pluginId: string;
  installed?: boolean;
  enabled?: boolean;
  version?: string;
}


export interface PluginState {
  marketplace: JsonRecord | null;
  marketplaceSource: string | null;
  marketplaceValid: boolean;
  installed: PluginEntry | null;
  available: PluginEntry | null;
}


export interface PluginChanges {
  addedMarketplace: boolean;
  addedPlugin: boolean;
}


export interface InstallationStatus {
  codexHome: string;
  plugin: PluginState;
  mode: Mode;
  modeSource: string;
  configError: string | null;
  legacyConfigError: string | null;
  healthy: boolean;
}


type ApplicableSetupPlan = Pick<SetupPlan, "codexHome" | "operations">
  & Partial<Pick<SetupPlan, "conflicts">>;


type InitialPluginState = Pick<
  PluginState,
  "marketplace" | "marketplaceValid" | "installed" | "available"
> & Partial<Pick<PluginState, "marketplaceSource">>;


function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}


function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}


export function resolveCodexHome(
  explicitPath?: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = explicitPath || environment.CODEX_HOME || join(homedir(), ".codex");
  const canonical = canonicalizePath(candidate);
  if (canonical === parse(canonical).root) {
    throw new Error("refusing to use a filesystem root as CODEX_HOME");
  }
  return canonical;
}


export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && MODES.includes(value as Mode);
}


async function pathInfo(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}


function pathInfoSync(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}


function canonicalizePath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...missing);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}


function assertCanonicalHome(codexHome: string): void {
  const resolved = resolve(codexHome);
  const canonical = canonicalizePath(resolved);
  if (canonical === parse(canonical).root) {
    throw new Error("refusing to use a filesystem root as CODEX_HOME");
  }
  if (canonical !== resolved) {
    throw new Error(`CODEX_HOME is no longer canonical: ${codexHome}`);
  }
  const info = pathInfoSync(resolved);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`CODEX_HOME must be a real directory: ${codexHome}`);
  }
}


function assertSafeParentChain(codexHome: string, target: string): void {
  assertCanonicalHome(codexHome);
  assertInside(codexHome, target);
  const parentRelative = relative(codexHome, dirname(target));
  if (!parentRelative || parentRelative === ".") {
    return;
  }
  let cursor = codexHome;
  for (const component of parentRelative.split(sep)) {
    cursor = join(cursor, component);
    const info = pathInfoSync(cursor);
    if (!info) {
      return;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`refusing symlink parent below CODEX_HOME: ${cursor}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`managed path parent is not a directory: ${cursor}`);
    }
  }
}


async function inspectJsonFile(path: string): Promise<FileInspection> {
  const info = await pathInfo(path);
  if (!info) {
    return { value: null, error: null, type: "missing", digest: null };
  }
  if (info.isSymbolicLink()) {
    return { value: null, error: "path is a symbolic link", type: "symlink", digest: null };
  }
  if (!info.isFile()) {
    return { value: null, error: "path is not a regular file", type: "non-file", digest: null };
  }
  const text = await readFile(path, "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
  try {
    return { value: JSON.parse(text), error: null, type: "file", digest };
  } catch (error) {
    return { value: null, error: errorMessage(error), type: "file", digest };
  }
}


export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}


function assertInside(base: string, target: string): void {
  const relativePath = relative(base, target);
  if (
    !relativePath
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`unsafe target outside CODEX_HOME: ${target}`);
  }
}


function modeConfig(mode: Mode): string {
  return `${JSON.stringify({ schemaVersion: 1, defaultMode: mode }, null, 2)}\n`;
}


function pluginDataTarget(codexHome: string): string {
  return join(codexHome, "plugins", "data", PLUGIN_DATA_DIRECTORY);
}


function isOwnedReceipt(value: unknown): value is OwnedReceipt {
  return Boolean(
    isRecord(value)
    && value.pluginId === PLUGIN_ID
    && value.marketplace === MARKETPLACE_NAME
    && value.schemaVersion === RECEIPT_SCHEMA_VERSION,
  );
}


function isOwnedModeConfig(value: unknown): value is OwnedModeConfig {
  return Boolean(
    isRecord(value)
    && value.schemaVersion === 1
    && isMode(value.defaultMode),
  );
}


async function addWriteOperation(
  plan: SetupPlan,
  label: string,
  target: string,
  content: string,
): Promise<void> {
  const info = await pathInfo(target);
  if (!info) {
    plan.operations.push({
      action: "create",
      kind: "write",
      label,
      target,
      content,
      expectedType: "missing",
    });
    return;
  }
  if (!info.isFile()) {
    plan.warnings.push(`${label} was preserved because ${target} is not a regular file.`);
    return;
  }
  if (await readFile(target, "utf8") === content) {
    plan.current.push({ label, target });
    return;
  }
  plan.operations.push({
    action: "update",
    kind: "write",
    label,
    target,
    content,
    expectedType: "file",
    expectedDigest: await digestFile(target),
  });
}


function addRemoveFileOperation(
  plan: SetupPlan,
  label: string,
  target: string,
  digest: string | null,
): void {
  plan.operations.push({
    action: "remove",
    kind: "remove",
    label,
    target,
    expectedType: "file",
    expectedDigest: digest,
  });
}


export async function createSetupPlan({
  codexHome,
  defaultMode = DEFAULT_MODE,
  modeExplicit = false,
}: {
  codexHome: string;
  defaultMode?: Mode;
  modeExplicit?: boolean;
}): Promise<SetupPlan> {
  if (!isMode(defaultMode)) {
    throw new Error(`unsupported orchestration mode: ${defaultMode}`);
  }
  const resolvedHome = resolveCodexHome(codexHome);
  const receiptPath = join(resolvedHome, "orchestration", "install.json");
  const legacyConfigTarget = join(resolvedHome, "orchestration", "config.json");
  const configTarget = join(pluginDataTarget(resolvedHome), "config.json");
  for (const target of [
    receiptPath,
    configTarget,
    legacyConfigTarget,
  ]) {
    assertSafeParentChain(resolvedHome, target);
  }

  const plan: SetupPlan = {
    codexHome: resolvedHome,
    defaultMode,
    current: [],
    operations: [],
    warnings: [],
    conflicts: [],
  };
  const receiptResult = await inspectJsonFile(receiptPath);
  const receiptOwned = receiptResult.type === "file" && isOwnedReceipt(receiptResult.value);
  if (receiptResult.type !== "missing" && !receiptOwned) {
    plan.warnings.push(`Unowned or invalid installation receipt was preserved: ${receiptPath}`);
  }

  const configResult = await inspectJsonFile(configTarget);
  const legacyConfigResult = await inspectJsonFile(legacyConfigTarget);
  const legacyConfig = legacyConfigResult.type === "file"
    && isOwnedModeConfig(legacyConfigResult.value)
    ? legacyConfigResult.value
    : null;
  const legacyConfigOwned = legacyConfig !== null;
  let pluginConfigReady = false;
  if (configResult.type === "missing") {
    if (modeExplicit || legacyConfigOwned) {
      plan.defaultMode = modeExplicit
        ? defaultMode
        : legacyConfig?.defaultMode ?? DEFAULT_MODE;
      await addWriteOperation(
        plan,
        "plugin default orchestration mode",
        configTarget,
        modeConfig(plan.defaultMode),
      );
      pluginConfigReady = true;
    } else {
      plan.defaultMode = DEFAULT_MODE;
      plan.current.push({
        label: `built-in default orchestration mode (${DEFAULT_MODE})`,
        target: configTarget,
      });
    }
  } else if (configResult.type !== "file" || !isOwnedModeConfig(configResult.value)) {
    plan.warnings.push(`Invalid or non-regular plugin config was preserved: ${configTarget}`);
    plan.defaultMode = legacyConfigOwned
      ? legacyConfig.defaultMode
      : DEFAULT_MODE;
    if (modeExplicit) {
      plan.conflicts.push(
        `Cannot set mode ${defaultMode} while the plugin config is invalid or non-regular: ${configTarget}`,
      );
    }
  } else if (modeExplicit && configResult.value.defaultMode !== defaultMode) {
    await addWriteOperation(
      plan,
      "plugin default orchestration mode",
      configTarget,
      modeConfig(defaultMode),
    );
    plan.defaultMode = defaultMode;
    pluginConfigReady = true;
  } else {
    plan.defaultMode = configResult.value.defaultMode;
    plan.current.push({ label: "plugin default orchestration mode", target: configTarget });
    pluginConfigReady = true;
  }
  if (legacyConfigOwned && pluginConfigReady) {
    addRemoveFileOperation(
      plan,
      "legacy global orchestration config",
      legacyConfigTarget,
      legacyConfigResult.digest,
    );
  } else if (legacyConfigResult.type !== "missing" && !legacyConfigOwned) {
    plan.warnings.push(`Invalid or non-regular legacy config was preserved: ${legacyConfigTarget}`);
  }

  if (receiptOwned) {
    addRemoveFileOperation(
      plan,
      "legacy installation receipt",
      receiptPath,
      receiptResult.digest,
    );
  }
  for (const operation of plan.operations) {
    assertSafeParentChain(resolvedHome, operation.target);
  }
  return plan;
}


async function copyOperation(operation: CopyOperation): Promise<void> {
  const sourceInfo = await stat(operation.source);
  await copyFile(operation.source, operation.target);
  await chmod(operation.target, sourceInfo.mode & 0o777);
}


async function assertSetupPrecondition(operation: SetupOperation): Promise<void> {
  const info = await pathInfo(operation.target);
  if (operation.expectedType === "missing") {
    if (info) {
      throw new Error(`managed setup target appeared after planning: ${operation.target}`);
    }
    return;
  }
  if (operation.expectedType === "file") {
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`managed setup target type changed after planning: ${operation.target}`);
    }
    if (await digestFile(operation.target) !== operation.expectedDigest) {
      throw new Error(`managed setup target changed after planning: ${operation.target}`);
    }
  }
}


export async function applySetupPlan(
  plan: ApplicableSetupPlan,
): Promise<Array<{ operation: SetupOperation; rollbackPath: string | null }>> {
  if (plan.conflicts?.length) {
    throw new Error("cannot apply setup while actionable conflicts remain");
  }
  await mkdir(plan.codexHome, { recursive: true });
  assertCanonicalHome(plan.codexHome);
  const transactionRoot = await mkdtemp(join(plan.codexHome, ".orchestration-transaction-"));
  const applied: Array<{ operation: SetupOperation; rollbackPath: string | null }> = [];
  try {
    for (const [index, operation] of plan.operations.entries()) {
      assertSafeParentChain(plan.codexHome, operation.target);
      await assertSetupPrecondition(operation);
      await mkdir(dirname(operation.target), { recursive: true });
      assertSafeParentChain(plan.codexHome, operation.target);
      const existing = await pathInfo(operation.target);
      const rollbackPath = existing ? join(transactionRoot, String(index)) : null;
      if (rollbackPath) {
        await rename(operation.target, rollbackPath);
      }
      try {
        if (operation.kind === "copy") {
          await copyOperation(operation);
        } else if (operation.kind === "write") {
          await writeFile(operation.target, operation.content, "utf8");
          if (existing?.isFile()) {
            await chmod(operation.target, existing.mode & 0o777);
          }
        }
      } catch (error) {
        await rm(operation.target, { recursive: true, force: true });
        if (rollbackPath) {
          await rename(rollbackPath, operation.target);
        }
        throw error;
      }
      applied.push({ operation, rollbackPath });
    }
  } catch (error) {
    for (const { operation, rollbackPath } of applied.reverse()) {
      await rm(operation.target, { recursive: true, force: true });
      if (rollbackPath) {
        await rename(rollbackPath, operation.target);
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(transactionRoot, { recursive: true, force: true });
  return applied;
}


export async function createUninstallPlan({
  codexHome,
}: {
  codexHome: string;
}): Promise<UninstallPlan> {
  const resolvedHome = resolveCodexHome(codexHome);
  const receiptPath = join(resolvedHome, "orchestration", "install.json");
  const configTarget = join(resolvedHome, "orchestration", "config.json");
  const pluginStateTarget = pluginDataTarget(resolvedHome);
  for (const target of [
    receiptPath,
    configTarget,
    pluginStateTarget,
  ]) {
    assertSafeParentChain(resolvedHome, target);
  }
  const plan: UninstallPlan = {
    codexHome: resolvedHome,
    operations: [],
    current: [],
    warnings: [],
  };
  const receiptResult = await inspectJsonFile(receiptPath);
  const receiptOwned = receiptResult.type === "file" && isOwnedReceipt(receiptResult.value);
  const configResult = await inspectJsonFile(configTarget);
  if (configResult.type === "file" && isOwnedModeConfig(configResult.value)) {
    plan.operations.push({
      action: "remove",
      kind: "remove",
      label: "orchestration config",
      target: configTarget,
      expectedType: "file",
      expectedDigest: configResult.digest,
    });
  } else if (configResult.type !== "missing") {
    plan.warnings.push(`Invalid or non-regular orchestration config was preserved: ${configTarget}`);
  }
  if (receiptOwned) {
    plan.operations.push({
      action: "remove",
      kind: "remove",
      label: "installation receipt",
      target: receiptPath,
      expectedType: "file",
      expectedDigest: receiptResult.digest,
    });
  } else if (receiptResult.type !== "missing") {
    plan.warnings.push(`Unowned or invalid installation receipt was preserved: ${receiptPath}`);
  }
  const pluginDataInfo = await pathInfo(pluginStateTarget);
  if (pluginDataInfo?.isDirectory() && !pluginDataInfo.isSymbolicLink()) {
    plan.operations.push({
      action: "remove",
      kind: "remove",
      label: "plugin data and mode state",
      target: pluginStateTarget,
      expectedType: "directory",
      expectedDevice: pluginDataInfo.dev,
      expectedInode: pluginDataInfo.ino,
    });
  } else if (pluginDataInfo) {
    plan.warnings.push(`Non-directory plugin data was preserved: ${pluginStateTarget}`);
  }
  for (const operation of plan.operations) {
    assertSafeParentChain(resolvedHome, operation.target);
  }
  return plan;
}


async function uninstallOperationIsCurrent(
  plan: UninstallPlan,
  operation: UninstallOperation,
): Promise<boolean> {
  const info = await pathInfo(operation.target);
  if (!info) {
    return false;
  }
  if (operation.expectedType === "file") {
    if (!info.isFile() || info.isSymbolicLink()) {
      plan.warnings.push(`Changed uninstall target was preserved: ${operation.target}`);
      return false;
    }
    if (await digestFile(operation.target) !== operation.expectedDigest) {
      plan.warnings.push(`Changed uninstall target was preserved: ${operation.target}`);
      return false;
    }
    return true;
  }
  if (operation.expectedType === "directory") {
    const unchanged = info.isDirectory()
      && !info.isSymbolicLink()
      && info.dev === operation.expectedDevice
      && info.ino === operation.expectedInode;
    if (!unchanged) {
      plan.warnings.push(`Changed uninstall target was preserved: ${operation.target}`);
    }
    return unchanged;
  }
  return false;
}


export async function applyUninstallPlan(
  plan: UninstallPlan,
): Promise<UninstallOperation[]> {
  await mkdir(plan.codexHome, { recursive: true });
  assertCanonicalHome(plan.codexHome);
  const transactionRoot = await mkdtemp(join(plan.codexHome, ".orchestration-uninstall-"));
  const moved: Array<{ operation: UninstallOperation; rollbackPath: string }> = [];
  try {
    for (const [index, operation] of plan.operations.entries()) {
      assertSafeParentChain(plan.codexHome, operation.target);
      if (!(await uninstallOperationIsCurrent(plan, operation))) {
        continue;
      }
      const rollbackPath = join(transactionRoot, String(index));
      await rename(operation.target, rollbackPath);
      moved.push({ operation, rollbackPath });
    }
  } catch (error) {
    for (const { operation, rollbackPath } of moved.reverse()) {
      await mkdir(dirname(operation.target), { recursive: true });
      await rename(rollbackPath, operation.target);
    }
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(transactionRoot, { recursive: true, force: true });
  for (const directory of [
    join(plan.codexHome, "orchestration"),
    join(plan.codexHome, "agents"),
  ]) {
    const info = await pathInfo(directory);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      continue;
    }
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ENOTEMPTY"].includes(errorCode(error) ?? "")) {
        throw error;
      }
    }
  }
  return moved.map(({ operation }) => operation);
}


export function createCodexClient({
  codexHome,
  environment = process.env,
  codexBin = environment.CODEX_ORCHESTRATION_CODEX_BIN || "codex",
}: {
  codexHome?: string | null;
  environment?: NodeJS.ProcessEnv;
  codexBin?: string;
} = {}): CodexClient {
  const resolvedHome = resolveCodexHome(codexHome, environment);
  return {
    async run(args: string[]): Promise<CodexCommandResult> {
      try {
        const result = await execFileAsync(codexBin, args, {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...environment, CODEX_HOME: resolvedHome },
        });
        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error) {
        const failure = isRecord(error) ? error : {};
        const detail = String(
          failure.stderr || failure.stdout || errorMessage(error),
        ).trim();
        throw new Error(`codex ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
      }
    },
  };
}


async function codexJson<T extends JsonRecord>(
  client: CodexClient,
  args: string[],
  onCommandSuccess: (() => void) | null = null,
): Promise<T> {
  const result = await client.run([...args, "--json"]);
  onCommandSuccess?.();
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!isRecord(value)) {
      throw new Error("response is not an object");
    }
    return value as T;
  } catch {
    throw new Error(`codex ${args.join(" ")} returned invalid JSON`);
  }
}


export async function inspectPluginState(client: CodexClient): Promise<PluginState> {
  const marketplaces = await codexJson<JsonRecord>(
    client,
    ["plugin", "marketplace", "list"],
  );
  const plugins = await codexJson<JsonRecord>(client, ["plugin", "list", "--available"]);
  const marketplace = recordArray(marketplaces.marketplaces)
    .find((entry) => entry.name === MARKETPLACE_NAME) || null;
  const sourceDetails = isRecord(marketplace?.marketplaceSource)
    ? marketplace.marketplaceSource
    : null;
  const marketplaceSource = optionalString(sourceDetails?.source)
    ?? optionalString(marketplace?.source);
  const marketplaceSourceType = optionalString(sourceDetails?.sourceType);
  const marketplaceValid = !marketplace || (
    marketplaceSourceType === "git"
    && marketplaceSource === MARKETPLACE_SOURCE
  );
  const installed = recordArray(plugins.installed)
    .find((entry) => entry.pluginId === PLUGIN_ID && entry.installed === true) as
      | PluginEntry
      | undefined;
  const available = recordArray(plugins.available)
    .find((entry) => entry.pluginId === PLUGIN_ID) as PluginEntry | undefined;
  return {
    marketplace,
    marketplaceSource,
    marketplaceValid,
    installed: installed ?? null,
    available: available ?? null,
  };
}


export async function setupPlugin(
  client: CodexClient,
  initialState: InitialPluginState,
): Promise<PluginChanges> {
  let addedMarketplace = false;
  let addedPlugin = false;
  try {
    if (initialState.marketplace && !initialState.marketplaceValid) {
      throw new Error(
        `marketplace ${MARKETPLACE_NAME} uses ${initialState.marketplaceSource || "an unknown source"}; `
        + `expected ${MARKETPLACE_SOURCE}`,
      );
    }
    if (initialState.installed) {
      if (initialState.installed.enabled !== true) {
        throw new Error(
          `plugin ${PLUGIN_ID} is installed but disabled; enable it from /plugins and rerun setup`,
        );
      }
      return { addedMarketplace, addedPlugin };
    }
    if (!initialState.marketplace) {
      await codexJson(
        client,
        ["plugin", "marketplace", "add", MARKETPLACE_SOURCE],
        () => {
          addedMarketplace = true;
        },
      );
    } else if (!initialState.available) {
      await codexJson(client, ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME]);
      const refreshed = await inspectPluginState(client);
      if (!refreshed.marketplaceValid) {
        throw new Error(
          `marketplace ${MARKETPLACE_NAME} changed source during setup; expected ${MARKETPLACE_SOURCE}`,
        );
      }
      if (refreshed.installed) {
        if (refreshed.installed.enabled !== true) {
          throw new Error(
            `plugin ${PLUGIN_ID} is installed but disabled; enable it from /plugins and rerun setup`,
          );
        }
        return { addedMarketplace, addedPlugin };
      }
      if (!refreshed.available) {
        throw new Error(`plugin ${PLUGIN_ID} is not available after marketplace upgrade`);
      }
    }
    await codexJson(client, ["plugin", "add", PLUGIN_ID], () => {
      addedPlugin = true;
    });
    return { addedMarketplace, addedPlugin };
  } catch (error) {
    if (addedPlugin) {
      try {
        await codexJson(client, ["plugin", "remove", PLUGIN_ID]);
      } catch {
        // Preserve the original setup failure.
      }
    }
    if (addedMarketplace) {
      try {
        await codexJson(client, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
      } catch {
        // Preserve the original setup failure.
      }
    }
    throw error;
  }
}


export async function rollbackPluginSetup(
  client: CodexClient,
  initialState: InitialPluginState,
  changes: PluginChanges | null | undefined,
): Promise<void> {
  if (changes?.addedPlugin && !initialState.installed) {
    try {
      await codexJson(client, ["plugin", "remove", PLUGIN_ID]);
    } catch {
      // Local rollback has already protected user files; report the original error.
    }
  }
  if (changes?.addedMarketplace && !initialState.marketplace) {
    try {
      await codexJson(client, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    } catch {
      // Preserve the original error.
    }
  }
}


export async function removePlugin(
  client: CodexClient,
  initialState: InitialPluginState,
): Promise<boolean> {
  if (initialState.marketplace && !initialState.marketplaceValid) {
    throw new Error(`refusing to remove a plugin from mismatched marketplace ${MARKETPLACE_NAME}`);
  }
  if (!initialState.installed) {
    return false;
  }
  await codexJson(client, ["plugin", "remove", PLUGIN_ID]);
  return true;
}


export async function inspectInstallation({
  codexHome,
  client,
}: {
  codexHome: string;
  client: CodexClient;
}): Promise<InstallationStatus> {
  const resolvedHome = resolveCodexHome(codexHome);
  const configTarget = join(pluginDataTarget(resolvedHome), "config.json");
  const legacyConfigTarget = join(resolvedHome, "orchestration", "config.json");
  for (const target of [
    configTarget,
    legacyConfigTarget,
  ]) {
    assertSafeParentChain(resolvedHome, target);
  }
  const plugin = await inspectPluginState(client);
  const config = await inspectJsonFile(configTarget);
  const legacyConfig = await inspectJsonFile(legacyConfigTarget);
  const configValid = config.type === "missing" || isOwnedModeConfig(config.value);
  const legacyModeConfig = isOwnedModeConfig(legacyConfig.value)
    ? legacyConfig.value
    : null;
  let mode = DEFAULT_MODE;
  let modeSource = "built-in default";
  if (isOwnedModeConfig(config.value)) {
    mode = config.value.defaultMode;
    modeSource = "plugin data";
  } else if (legacyModeConfig) {
    mode = legacyModeConfig.defaultMode;
    modeSource = "legacy fallback";
  }
  const healthy = Boolean(
    plugin.marketplace
    && plugin.marketplaceValid
    && plugin.installed
    && plugin.installed.enabled === true
    && configValid,
  );
  return {
    codexHome: resolvedHome,
    plugin,
    mode,
    modeSource,
    configError: config.error,
    legacyConfigError: legacyConfig.error,
    healthy,
  };
}


export function formatPlan(
  plan: {
    codexHome: string;
    current?: PlanItem[];
    operations?: OperationBase[];
    warnings?: string[];
    conflicts?: string[];
  },
): string {
  const lines = [`Codex home: ${plan.codexHome}`];
  for (const item of plan.current || []) {
    lines.push(`CURRENT  ${item.label}: ${item.target}`);
  }
  for (const operation of plan.operations || []) {
    lines.push(`${operation.action.toUpperCase().padEnd(7)}  ${operation.label}: ${operation.target}`);
  }
  for (const warning of plan.warnings || []) {
    lines.push(`WARNING  ${warning}`);
  }
  for (const conflict of plan.conflicts || []) {
    lines.push(`CONFLICT ${conflict}`);
  }
  return lines.join("\n");
}


export function formatStatus(status: InstallationStatus): string {
  let marketplaceSummary = "missing";
  if (status.plugin.marketplace) {
    marketplaceSummary = status.plugin.marketplaceValid ? "configured" : "source mismatch";
  }
  let pluginSummary = "missing";
  if (status.plugin.installed) {
    const version = status.plugin.installed.version || "unknown version";
    const enabled = status.plugin.installed.enabled === true ? "enabled" : "disabled";
    pluginSummary = `installed (${version}, ${enabled})`;
  }
  const lines = [
    `Codex home: ${status.codexHome}`,
    `Marketplace: ${marketplaceSummary}`,
    `Plugin: ${pluginSummary}`,
    `Default mode: ${status.mode} (${status.modeSource})`,
  ];
  if (status.configError) {
    lines.push(`Plugin config: invalid (${status.configError})`);
  }
  if (status.legacyConfigError) {
    lines.push(`Legacy config: preserved (${status.legacyConfigError})`);
  }
  return lines.join("\n");
}
