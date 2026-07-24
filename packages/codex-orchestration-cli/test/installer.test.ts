import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  MARKETPLACE_SOURCE,
  PLUGIN_ID,
  applySetupPlan,
  applyUninstallPlan,
  createSetupPlan,
  createUninstallPlan,
  digestFile,
  formatStatus,
  inspectInstallation,
  inspectPluginState,
  resolveCodexHome,
  setupPlugin,
  type CodexClient,
  type SetupOperation,
} from "../src/installer.js";


const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = join(packageRoot, "dist", "bin", "codex-orchestration.js");


interface MockState {
  marketplace: boolean;
  marketplaceSource: string;
  marketplaceSourceType: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  installedFalseEntry: boolean;
}


interface MockLogEntry {
  command: string;
  CODEX_HOME: string;
}


async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}


function defaultMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    marketplace: false,
    marketplaceSource: MARKETPLACE_SOURCE,
    marketplaceSourceType: "git",
    installed: false,
    enabled: true,
    available: false,
    installedFalseEntry: false,
    ...overrides,
  };
}


async function writeMockState(
  codexHome: string,
  overrides: Partial<MockState> = {},
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "mock-plugin-state.json"),
    JSON.stringify(defaultMockState(overrides)),
    "utf8",
  );
}


async function readMockLog(codexHome: string): Promise<MockLogEntry[]> {
  const contents = await readFile(join(codexHome, "mock-codex.log"), "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MockLogEntry);
}


function mutationCommands(entries: MockLogEntry[]): string[] {
  return entries
    .map((entry) => entry.command)
    .filter((command) => ![
      "plugin marketplace list",
      "plugin list --available",
    ].includes(command));
}


async function createMockCodex(root: string): Promise<string> {
  const executablePath = join(root, "mock-codex.js");
  await writeFile(executablePath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
fs.mkdirSync(home, { recursive: true });
const statePath = path.join(home, "mock-plugin-state.json");
const logPath = path.join(home, "mock-codex.log");
const args = process.argv.slice(2);
const command = args.filter((value) => value !== "--json").join(" ");
fs.appendFileSync(logPath, JSON.stringify({ command, CODEX_HOME: home }) + "\\n");
const defaults = {
  marketplace: false,
  marketplaceSource: ${JSON.stringify(MARKETPLACE_SOURCE)},
  marketplaceSourceType: "git",
  installed: false,
  enabled: true,
  available: false,
  installedFalseEntry: false,
};
let state = defaults;
if (fs.existsSync(statePath)) {
  state = { ...defaults, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
}
if (process.env.MOCK_CODEX_FAIL_MATCH && command.includes(process.env.MOCK_CODEX_FAIL_MATCH)) {
  process.stderr.write("injected mock failure\\n");
  process.exit(9);
}
let output = {};
if (command === "plugin marketplace list") {
  output = {
    marketplaces: state.marketplace ? [{
      name: "orijinmain-skills",
      marketplaceSource: {
        sourceType: state.marketplaceSourceType,
        source: state.marketplaceSource,
      },
    }] : [],
  };
} else if (command === "plugin list --available") {
  const installed = state.installed
    ? [{
      pluginId: ${JSON.stringify(PLUGIN_ID)},
      installed: true,
      enabled: state.enabled,
      version: "0.2.1",
    }]
    : (state.installedFalseEntry ? [{
      pluginId: ${JSON.stringify(PLUGIN_ID)},
      installed: false,
      enabled: true,
      version: "0.2.1",
    }] : []);
  const available = state.marketplace && state.available
    ? [{ pluginId: ${JSON.stringify(PLUGIN_ID)}, installed: false, version: "0.2.1" }]
    : [];
  output = { installed, available };
} else if (command === "plugin marketplace add ${MARKETPLACE_SOURCE}") {
  state.marketplace = true;
  state.marketplaceSource = ${JSON.stringify(MARKETPLACE_SOURCE)};
  state.marketplaceSourceType = "git";
  state.available = true;
} else if (command === "plugin marketplace upgrade orijinmain-skills") {
  if (!state.marketplace) process.exit(8);
  state.available = true;
} else if (command === "plugin marketplace remove orijinmain-skills") {
  state.marketplace = false;
  state.available = false;
} else if (command === "plugin add ${PLUGIN_ID}") {
  if (!state.marketplace || !state.available) process.exit(7);
  state.installed = true;
  state.enabled = true;
  state.available = false;
} else if (command === "plugin remove ${PLUGIN_ID}") {
  state.installed = false;
  state.available = state.marketplace;
} else {
  process.stderr.write("unsupported mock command: " + command + "\\n");
  process.exit(6);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(output));
`, "utf8");
  await chmod(executablePath, 0o755);
  return executablePath;
}


function runCli(
  codexHome: string,
  mockCodex: string,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_ORCHESTRATION_CODEX_BIN: mockCodex,
      ...extraEnvironment,
    },
  });
}


test("CLI help uses the Corch command name", () => {
  const result = spawnSync(process.execPath, [executable, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^corch 0\.2\.1$/m);
  assert.match(result.stdout, /^  corch setup \[options\]$/m);
  assert.doesNotMatch(result.stdout, /^  codex-orchestration setup/m);
});


function pluginClient({
  marketplaceSource = MARKETPLACE_SOURCE,
  marketplaceSourceType = "git",
  installed = true,
  enabled = true,
  available = false,
  installedFalseEntry = false,
}: Partial<MockState> = {}): CodexClient {
  return {
    async run(args: string[]) {
      const command = args.filter((value) => value !== "--json").join(" ");
      if (command === "plugin marketplace list") {
        return {
          stdout: JSON.stringify({
            marketplaces: [{
              name: "orijinmain-skills",
              marketplaceSource: {
                sourceType: marketplaceSourceType,
                source: marketplaceSource,
              },
            }],
          }),
          stderr: "",
        };
      }
      if (command === "plugin list --available") {
        const installedEntries = installed
          ? [{ pluginId: PLUGIN_ID, installed: true, enabled, version: "0.2.1" }]
          : (installedFalseEntry
            ? [{ pluginId: PLUGIN_ID, installed: false, enabled: true }]
            : []);
        return {
          stdout: JSON.stringify({
            installed: installedEntries,
            available: available ? [{ pluginId: PLUGIN_ID, installed: false }] : [],
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
}


test("fresh local setup uses the built-in mode without creating config", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-fresh-");
  const first = await createSetupPlan({ codexHome });
  assert.equal(first.operations.length, 0);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.defaultMode, "full");
  await applySetupPlan(first);
  await assert.rejects(
    readFile(
      join(
        codexHome,
        "plugins",
        "data",
        "codex-orchestration-orijinmain-skills",
        "config.json",
      ),
    ),
    /ENOENT/,
  );
  const second = await createSetupPlan({ codexHome });
  assert.equal(second.operations.length, 0);
  assert.equal(second.warnings.length, 0);
});


test("setup migrates the default mode and removes the old receipt", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-migration-");
  const legacyConfig = join(codexHome, "orchestration", "config.json");
  const receiptPath = join(codexHome, "orchestration", "install.json");
  await mkdir(dirname(legacyConfig), { recursive: true });
  await writeFile(
    legacyConfig,
    `${JSON.stringify({ schemaVersion: 1, defaultMode: "lite" })}\n`,
    "utf8",
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 2,
      pluginId: PLUGIN_ID,
      marketplace: "orijinmain-skills",
    })}\n`,
    "utf8",
  );

  const plan = await createSetupPlan({ codexHome });
  assert.equal(plan.defaultMode, "lite");
  await applySetupPlan(plan);
  await assert.rejects(readFile(legacyConfig), /ENOENT/);
  await assert.rejects(readFile(receiptPath), /ENOENT/);
  const migrated = JSON.parse(
    await readFile(
      join(
        codexHome,
        "plugins",
        "data",
        "codex-orchestration-orijinmain-skills",
        "config.json",
      ),
      "utf8",
    ),
  );
  assert.equal(migrated.defaultMode, "lite");
});


test("symlink parents cannot redirect setup writes outside CODEX_HOME", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-parent-link-");
  const outside = await temporaryDirectory(t, "codex-orchestration-outside-");
  await mkdir(join(codexHome, "plugins"));
  await symlink(outside, join(codexHome, "plugins", "data"));
  await assert.rejects(
    createSetupPlan({
      codexHome,
      defaultMode: "lite",
      modeExplicit: true,
    }),
    /symlink parent below CODEX_HOME/,
  );
  assert.deepEqual(await readdir(outside), []);

  const secondHome = await temporaryDirectory(t, "codex-orchestration-link-swap-");
  const secondOutside = await temporaryDirectory(t, "codex-orchestration-outside-swap-");
  const plan = await createSetupPlan({
    codexHome: secondHome,
    defaultMode: "lite",
    modeExplicit: true,
  });
  await symlink(secondOutside, join(secondHome, "plugins"));
  await assert.rejects(applySetupPlan(plan), /symlink parent below CODEX_HOME/);
  assert.deepEqual(await readdir(secondOutside), []);
});


test("CODEX_HOME is canonicalized through safe non-root symlinks and rejects roots", async (t) => {
  const target = await temporaryDirectory(t, "codex-orchestration-home-target-");
  const parent = await temporaryDirectory(t, "codex-orchestration-home-link-");
  const link = join(parent, "codex-link");
  await symlink(target, link);
  assert.equal(resolveCodexHome(link), await realpath(target));
  assert.throws(() => resolveCodexHome("/"), /filesystem root/);
});


test("config directories, symlinks, and invalid JSON are preserved", async (t) => {
  for (const kind of ["directory", "symlink", "invalid JSON"]) {
    const codexHome = await temporaryDirectory(
      t,
      `codex-orchestration-config-${kind.replace(/\W/g, "-")}-`,
    );
    const configPath = join(codexHome, "orchestration", "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    let external = null;
    if (kind === "directory") {
      await mkdir(configPath);
    } else if (kind === "symlink") {
      external = join(
        await temporaryDirectory(t, "codex-orchestration-config-external-"),
        "config.json",
      );
      await writeFile(external, "external config\n", "utf8");
      await symlink(external, configPath);
    } else {
      await writeFile(configPath, "{broken\n", "utf8");
    }

    const setupPlan = await createSetupPlan({ codexHome });
    assert.match(setupPlan.warnings.join("\n"), /config was preserved/);
    await applySetupPlan(setupPlan);
    const uninstallPlan = await createUninstallPlan({ codexHome });
    assert.match(uninstallPlan.warnings.join("\n"), /config was preserved/);
    await applyUninstallPlan(uninstallPlan);

    const info = await lstat(configPath);
    if (kind === "directory") {
      assert.equal(info.isDirectory(), true);
    } else if (kind === "symlink") {
      assert.equal(info.isSymbolicLink(), true);
      assert.ok(external);
      assert.equal(await readFile(external, "utf8"), "external config\n");
    } else {
      assert.equal(await readFile(configPath, "utf8"), "{broken\n");
    }
  }
});


test("stale uninstall targets are revalidated and preserved", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-stale-uninstall-");
  const receiptPath = join(codexHome, "orchestration", "install.json");
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      schemaVersion: 2,
      pluginId: PLUGIN_ID,
      marketplace: "orijinmain-skills",
    })}\n`,
    "utf8",
  );
  const plan = await createUninstallPlan({ codexHome });
  const changedReceipt = '{"changed":true}\n';
  await writeFile(receiptPath, changedReceipt, "utf8");

  await applyUninstallPlan(plan);
  assert.equal(await readFile(receiptPath, "utf8"), changedReceipt);
  assert.match(plan.warnings.join("\n"), /Changed uninstall target was preserved/);
});


test("plugin-data symlinks are preserved during uninstall", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-data-link-");
  const external = await temporaryDirectory(t, "codex-orchestration-data-external-");
  const target = join(
    codexHome,
    "plugins",
    "data",
    "codex-orchestration-orijinmain-skills",
  );
  await mkdir(dirname(target), { recursive: true });
  await symlink(external, target);

  const plan = await createUninstallPlan({ codexHome });
  assert.match(plan.warnings.join("\n"), /plugin data was preserved/);
  await applyUninstallPlan(plan);
  assert.equal((await lstat(target)).isSymbolicLink(), true);
});


test("local setup rolls back earlier writes when a later operation fails", async (t) => {
  const rawHome = await temporaryDirectory(t, "codex-orchestration-rollback-");
  const codexHome = resolveCodexHome(rawHome);
  const existing = join(codexHome, "existing.txt");
  await writeFile(existing, "original\n", "utf8");
  const plan: {
    codexHome: string;
    conflicts: string[];
    operations: SetupOperation[];
  } = {
    codexHome,
    conflicts: [],
    operations: [
      {
        action: "update",
        kind: "write",
        label: "existing",
        target: existing,
        content: "changed\n",
        expectedType: "file",
        expectedDigest: await digestFile(existing),
      },
      {
        action: "create",
        kind: "copy",
        label: "missing",
        target: join(codexHome, "new.txt"),
        source: join(codexHome, "missing.txt"),
        expectedType: "missing",
      },
    ],
  };
  await assert.rejects(applySetupPlan(plan), /ENOENT/);
  assert.equal(await readFile(existing, "utf8"), "original\n");
  assert.deepEqual(await readdir(codexHome), ["existing.txt"]);
});


test("plugin inspection is sequential and ignores installed:false entries", async () => {
  const client = pluginClient({
    installed: false,
    installedFalseEntry: true,
    available: true,
  });
  const calls: string[] = [];
  const tracingClient = {
    async run(args: string[]) {
      calls.push(args.filter((value) => value !== "--json").join(" "));
      return client.run(args);
    },
  };
  const state = await inspectPluginState(tracingClient);
  assert.deepEqual(calls, ["plugin marketplace list", "plugin list --available"]);
  assert.equal(state.marketplaceValid, true);
  assert.equal(state.installed, null);
  assert.equal(state.available?.pluginId, PLUGIN_ID);
});


test("setup rollback ownership is recorded only after a mutation command succeeds", async () => {
  const calls: string[] = [];
  const client = {
    async run(args: string[]) {
      const command = args.filter((value) => value !== "--json").join(" ");
      calls.push(command);
      if (command === `plugin marketplace add ${MARKETPLACE_SOURCE}`) {
        return { stdout: "not JSON", stderr: "" };
      }
      if (command === "plugin marketplace remove orijinmain-skills") {
        return { stdout: "{}", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
  await assert.rejects(
    setupPlugin(client, {
      marketplace: null,
      marketplaceValid: true,
      installed: null,
      available: null,
    }),
    /returned invalid JSON/,
  );
  assert.deepEqual(calls, [
    `plugin marketplace add ${MARKETPLACE_SOURCE}`,
    "plugin marketplace remove orijinmain-skills",
  ]);
});


test("disabled plugins make status unhealthy", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-status-");
  await applySetupPlan(await createSetupPlan({ codexHome }));

  const disabled = await inspectInstallation({
    codexHome,
    client: pluginClient({ enabled: false }),
  });
  assert.equal(disabled.healthy, false);
  assert.match(formatStatus(disabled), /disabled/);
});


test("CLI performs fresh setup, healthy status, idempotent setup, and uninstall", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-cli-");
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const mockCodex = await createMockCodex(root);

  const dryRun = runCli(codexHome, mockCodex, ["setup", "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run complete/);
  assert.deepEqual(
    (await readdir(codexHome)).sort(),
    ["mock-codex.log", "mock-plugin-state.json"],
  );

  const setup = runCli(codexHome, mockCodex, ["setup", "--mode", "lite", "--yes"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Setup complete/);

  const status = runCli(codexHome, mockCodex, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Plugin: installed \(0\.2\.1, enabled\)/);
  assert.match(status.stdout, /Default mode: lite/);

  const refresh = runCli(codexHome, mockCodex, ["setup", "--yes"]);
  assert.equal(refresh.status, 0, refresh.stderr);
  const log = await readMockLog(codexHome);
  assert.deepEqual(mutationCommands(log), [
    `plugin marketplace add ${MARKETPLACE_SOURCE}`,
    `plugin add ${PLUGIN_ID}`,
  ]);
  assert.ok(log.every((entry) => entry.CODEX_HOME === resolveCodexHome(codexHome)));

  const pluginData = join(
    codexHome,
    "plugins",
    "data",
    "codex-orchestration-orijinmain-skills",
    "sessions",
  );
  await mkdir(pluginData, { recursive: true });
  await writeFile(join(pluginData, "state.json"), "{}\n", "utf8");

  const uninstall = runCli(codexHome, mockCodex, ["uninstall", "--yes"]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  await assert.rejects(
    readFile(join(codexHome, "orchestration", "config.json")),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(join(codexHome, "orchestration", "install.json")),
    /ENOENT/,
  );
  await assert.rejects(readdir(pluginData), /ENOENT/);
  const mockState = JSON.parse(
    await readFile(join(codexHome, "mock-plugin-state.json"), "utf8"),
  );
  assert.equal(mockState.installed, false);
  assert.equal(mockState.marketplace, true);
});


test("existing marketplace installs an available plugin without upgrading", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-available-");
  const codexHome = join(root, "codex-home");
  await writeMockState(codexHome, { marketplace: true, available: true });
  const mockCodex = await createMockCodex(root);

  const setup = runCli(codexHome, mockCodex, ["setup", "--yes"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(mutationCommands(await readMockLog(codexHome)), [
    `plugin add ${PLUGIN_ID}`,
  ]);
});


test("an unavailable plugin triggers one marketplace refresh before install", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-upgrade-");
  const codexHome = join(root, "codex-home");
  await writeMockState(codexHome, { marketplace: true, available: false });
  const mockCodex = await createMockCodex(root);

  const setup = runCli(codexHome, mockCodex, ["setup", "--yes"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(mutationCommands(await readMockLog(codexHome)), [
    "plugin marketplace upgrade orijinmain-skills",
    `plugin add ${PLUGIN_ID}`,
  ]);
});


test("a mismatched marketplace source blocks setup without mutation", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-source-conflict-");
  const codexHome = join(root, "codex-home");
  await writeMockState(codexHome, {
    marketplace: true,
    marketplaceSource: "https://example.invalid/orijinmain/skills.git",
    available: true,
  });
  const mockCodex = await createMockCodex(root);

  const setup = runCli(codexHome, mockCodex, ["setup", "--yes"]);
  assert.equal(setup.status, 2);
  assert.match(setup.stderr, /must use https:\/\/github\.com\/orijinmain\/skills\.git/);
  assert.deepEqual(mutationCommands(await readMockLog(codexHome)), []);
  await assert.rejects(
    readFile(join(codexHome, "orchestration", "install.json")),
    /ENOENT/,
  );
});


test("an installed but disabled plugin blocks setup with enable guidance", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-disabled-");
  const codexHome = join(root, "codex-home");
  await writeMockState(codexHome, {
    marketplace: true,
    installed: true,
    enabled: false,
  });
  const mockCodex = await createMockCodex(root);

  const setup = runCli(codexHome, mockCodex, ["setup", "--yes"]);
  assert.equal(setup.status, 2);
  assert.match(setup.stderr, /Enable it from \/plugins/);
  assert.deepEqual(mutationCommands(await readMockLog(codexHome)), []);
  await assert.rejects(
    readFile(join(codexHome, "orchestration", "install.json")),
    /ENOENT/,
  );
});


test("CLI rolls back a newly added marketplace when plugin installation fails", async (t) => {
  const root = await temporaryDirectory(t, "codex-orchestration-cli-failure-");
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const mockCodex = await createMockCodex(root);
  const failed = runCli(
    codexHome,
    mockCodex,
    ["setup", "--yes"],
    { MOCK_CODEX_FAIL_MATCH: "plugin add codex-orchestration" },
  );
  assert.equal(failed.status, 2);
  const state = JSON.parse(
    await readFile(join(codexHome, "mock-plugin-state.json"), "utf8"),
  );
  assert.equal(state.marketplace, false);
  assert.equal(state.installed, false);
  await assert.rejects(
    readFile(join(codexHome, "orchestration", "install.json")),
    /ENOENT/,
  );
});
