#!/usr/bin/env node

import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_MODE,
  MARKETPLACE_SOURCE,
  applySetupPlan,
  applyUninstallPlan,
  createCodexClient,
  createSetupPlan,
  createUninstallPlan,
  formatPlan,
  formatStatus,
  inspectInstallation,
  inspectPluginState,
  isMode,
  removePlugin,
  resolveCodexHome,
  rollbackPluginSetup,
  setupPlugin,
  type CodexClient,
  type Mode,
} from "../src/installer.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version: string };

type Command = "setup" | "status" | "uninstall" | "help" | "version";

interface CliOptions {
  command: Command;
  codexHome: string | null;
  defaultMode: Mode;
  modeExplicit: boolean;
  dryRun: boolean;
  yes: boolean;
}


function help(): string {
  return `corch ${packageMetadata.version}

Usage:
  corch setup [options]
  corch status [options]
  corch uninstall [options]

Commands:
  setup              Install or repair the plugin and configure its default mode
  status             Inspect plugin and mode state
  uninstall          Remove the plugin and its owned data

Options:
  --codex-home PATH  Target Codex home (default: CODEX_HOME or ~/.codex)
  --mode MODE        Set the persistent default: off, lite, full, or ultra
  --dry-run          Preview without changing files or plugin state
  --yes              Apply without interactive confirmation
  -h, --help         Show this help
  -v, --version      Show the package version
`;
}


function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "setup",
    codexHome: null,
    defaultMode: DEFAULT_MODE,
    modeExplicit: false,
    dryRun: false,
    yes: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift() as Command;
  }
  while (args.length) {
    const argument = args.shift();
    if (argument === "--codex-home") {
      const value = args.shift();
      if (!value) {
        throw new Error("--codex-home requires a path");
      }
      options.codexHome = value;
    } else if (argument === "--mode") {
      const value = args.shift();
      if (!isMode(value)) {
        throw new Error("--mode must be off, lite, full, or ultra");
      }
      options.defaultMode = value;
      options.modeExplicit = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--yes") {
      options.yes = true;
    } else if (argument === "-h" || argument === "--help") {
      options.command = "help";
    } else if (argument === "-v" || argument === "--version") {
      options.command = "version";
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!["setup", "status", "uninstall", "help", "version"].includes(options.command)) {
    throw new Error(`unsupported command: ${options.command}`);
  }
  if (options.command !== "setup" && options.modeExplicit) {
    throw new Error("--mode is supported only by setup");
  }
  return options;
}


async function confirmAction(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("non-interactive changes require --yes");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}


async function runSetup(
  options: CliOptions,
  codexHome: string,
  client: CodexClient,
): Promise<number> {
  const [initialPluginState, plan] = await Promise.all([
    inspectPluginState(client),
    createSetupPlan({
      codexHome,
      defaultMode: options.defaultMode,
      modeExplicit: options.modeExplicit,
    }),
  ]);
  let marketplaceAction = "add";
  if (initialPluginState.marketplace) {
    marketplaceAction = initialPluginState.marketplaceValid ? "keep" : "source mismatch";
  }
  const disabledPlugin = Boolean(
    initialPluginState.installed
    && initialPluginState.installed.enabled !== true,
  );
  console.log(`Plugin marketplace: ${marketplaceAction}`);
  let pluginAction = "install";
  if (initialPluginState.installed) {
    pluginAction = disabledPlugin ? "disabled" : "keep";
  }
  console.log(`Plugin: ${pluginAction}`);
  console.log(formatPlan(plan));
  if (!initialPluginState.marketplaceValid || disabledPlugin || plan.conflicts.length) {
    if (!initialPluginState.marketplaceValid) {
      console.error(
        `CONFLICT: ${initialPluginState.marketplace?.name} must use ${MARKETPLACE_SOURCE}; `
        + `found ${initialPluginState.marketplaceSource || "unknown source"}.`,
      );
    }
    if (disabledPlugin) {
      console.error(
        `CONFLICT: ${initialPluginState.installed?.pluginId || "codex-orchestration"} is disabled. `
        + "Enable it from /plugins, then rerun setup.",
      );
    }
    console.error("Setup stopped; resolve the conflicts above and rerun setup.");
    return 2;
  }
  if (options.dryRun) {
    console.log("Dry run complete; no changes made.");
    return 0;
  }
  if (!options.yes && !(await confirmAction("Apply the orchestration setup?"))) {
    console.log("Setup cancelled.");
    return 0;
  }

  const pluginChanges = await setupPlugin(client, initialPluginState);
  try {
    await applySetupPlan(plan);
  } catch (error) {
    await rollbackPluginSetup(client, initialPluginState, pluginChanges);
    throw error;
  }
  for (const warning of plan.warnings) {
    console.warn(`WARNING: ${warning}`);
  }
  console.log(`Setup complete with default ${plan.defaultMode} mode.`);
  console.log("Start a new Codex task, review the plugin hooks with /hooks, and trust them to activate orchestration and virtual worker routing.");
  return 0;
}


async function runStatus(codexHome: string, client: CodexClient): Promise<number> {
  const status = await inspectInstallation({ codexHome, client });
  console.log(formatStatus(status));
  return status.healthy ? 0 : 1;
}


async function runUninstall(
  options: CliOptions,
  codexHome: string,
  client: CodexClient,
): Promise<number> {
  const [initialPluginState, plan] = await Promise.all([
    inspectPluginState(client),
    createUninstallPlan({ codexHome }),
  ]);
  console.log(`Plugin: ${initialPluginState.installed ? "remove" : "already absent"}`);
  console.log("Marketplace: keep");
  console.log(formatPlan(plan));
  if (options.dryRun) {
    console.log("Dry run complete; no changes made.");
    return 0;
  }
  if (!options.yes && !(await confirmAction("Uninstall Codex orchestration?"))) {
    console.log("Uninstall cancelled.");
    return 0;
  }
  const removedPlugin = await removePlugin(client, initialPluginState);
  try {
    await applyUninstallPlan(plan);
  } catch (error) {
    if (removedPlugin) {
      try {
        await setupPlugin(client, await inspectPluginState(client));
      } catch {
        console.warn("WARNING: local uninstall rolled back, but the plugin could not be reinstalled automatically.");
      }
    }
    throw error;
  }
  for (const warning of plan.warnings) {
    console.warn(`WARNING: ${warning}`);
  }
  console.log("Uninstall complete. The marketplace was retained for other plugins.");
  return 0;
}


async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(help());
    return 0;
  }
  if (options.command === "version") {
    console.log(packageMetadata.version);
    return 0;
  }
  const codexHome = resolveCodexHome(options.codexHome);
  const client = createCodexClient({ codexHome });
  if (options.command === "status") {
    return runStatus(codexHome, client);
  }
  if (options.command === "uninstall") {
    return runUninstall(options, codexHome, client);
  }
  return runSetup(options, codexHome, client);
}


main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 2;
  });
