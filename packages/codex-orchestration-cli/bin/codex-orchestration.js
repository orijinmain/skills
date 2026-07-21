#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  applySetupPlan,
  createSetupPlan,
  formatPlan,
  resolveCodexHome,
} from "../src/installer.js";


const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoot = join(packageRoot, "dist", "orchestrate-codex-agents");


function help() {
  return `codex-orchestration ${packageMetadata.version}

Usage:
  codex-orchestration setup [options]
  codex-orchestration status [options]

Commands:
  setup              Install or update the managed Codex orchestration files
  status             Check whether the managed installation is current

Options:
  --codex-home PATH  Target Codex home (default: CODEX_HOME or ~/.codex)
  --dry-run          Print the setup plan without writing
  --force            Back up and replace differing managed files and config values
  --yes              Apply without an interactive confirmation
  --skip-policy      Do not manage CODEX_HOME/AGENTS.md
  --skip-config      Do not merge CODEX_HOME/config.toml
  -h, --help         Show this help
  -v, --version      Show the package version
`;
}


function parseArguments(argv) {
  const options = {
    command: "setup",
    codexHome: null,
    dryRun: false,
    force: false,
    yes: false,
    skipPolicy: false,
    skipConfig: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args.shift();
  }
  while (args.length) {
    const argument = args.shift();
    if (argument === "--codex-home") {
      const value = args.shift();
      if (!value) {
        throw new Error("--codex-home requires a path");
      }
      options.codexHome = value;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--yes") {
      options.yes = true;
    } else if (argument === "--skip-policy") {
      options.skipPolicy = true;
    } else if (argument === "--skip-config") {
      options.skipConfig = true;
    } else if (argument === "-h" || argument === "--help") {
      options.command = "help";
    } else if (argument === "-v" || argument === "--version") {
      options.command = "version";
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!["setup", "status", "help", "version"].includes(options.command)) {
    throw new Error(`unsupported command: ${options.command}`);
  }
  return options;
}


async function confirmSetup(count) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("non-interactive setup requires --yes");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Apply ${count} change(s)? [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}


async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(help());
    return 0;
  }
  if (options.command === "version") {
    console.log(packageMetadata.version);
    return 0;
  }

  const plan = await createSetupPlan({
    codexHome: resolveCodexHome(options.codexHome),
    payloadRoot,
    force: options.force,
    skipPolicy: options.skipPolicy,
    skipConfig: options.skipConfig,
  });
  console.log(formatPlan(plan));

  if (options.command === "status") {
    if (!plan.operations.length && !plan.conflicts.length) {
      console.log("Codex orchestration is current.");
      return 0;
    }
    console.error("Codex orchestration needs setup or conflict resolution.");
    return 1;
  }
  if (plan.conflicts.length) {
    console.error(
      "Setup stopped. Review conflicts, then rerun with --force; replacements will receive backups.",
    );
    return 2;
  }
  if (!plan.operations.length) {
    console.log("Nothing to change.");
    return 0;
  }
  if (options.dryRun) {
    console.log("Dry run complete; no files changed.");
    return 0;
  }
  if (!options.yes && !(await confirmSetup(plan.operations.length))) {
    console.log("Setup cancelled.");
    return 0;
  }

  const applied = await applySetupPlan(plan);
  for (const { backup } of applied) {
    if (backup) {
      console.log(`BACKUP   ${backup}`);
    }
  }
  console.log(`Applied ${applied.length} change(s). Start a new Codex task to load them.`);
  return 0;
}


main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  });
