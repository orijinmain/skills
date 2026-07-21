import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applySetupPlan,
  createSetupPlan,
  mergeConfig,
  renderManagedPolicy,
} from "../src/installer.js";


const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoot = join(packageRoot, "dist", "orchestrate-codex-agents");
const executable = join(packageRoot, "bin", "codex-orchestration.js");


async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}


test("managed policy appends and replaces only its marked block", () => {
  const snippet = "<!-- orchestrate-codex-agents:start -->\nnew\n<!-- orchestrate-codex-agents:end -->";
  const appended = renderManagedPolicy("personal rule\n", snippet);
  assert.equal(appended, `personal rule\n\n${snippet}\n`);

  const replaced = renderManagedPolicy(
    "personal rule\n\n<!-- orchestrate-codex-agents:start -->\nold\n<!-- orchestrate-codex-agents:end -->\n",
    snippet,
  );
  assert.equal(replaced, `personal rule\n\n${snippet}\n`);
  assert.throws(
    () => renderManagedPolicy("<!-- orchestrate-codex-agents:start -->", snippet),
    /markers are missing or duplicated/,
  );
  assert.throws(
    () => renderManagedPolicy(`${snippet}\n${snippet}`, snippet),
    /markers are missing or duplicated/,
  );
});


test("config merge ignores assignments and tables inside multiline strings", () => {
  const existing = `instructions = """\n[agents]\nmodel = "example"\n"""\n\n[other]\nenabled = true\n`;
  const snippet = `model = "gpt-5.6-sol"\n\n[agents]\nmax_depth = 1\n`;
  const merged = mergeConfig(existing, snippet, false);

  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /instructions = """\n\[agents\]\nmodel = "example"\n"""/);
  assert.match(merged.text, /^model = "gpt-5\.6-sol"$/m);
  assert.match(merged.text, /\[agents\]\nmax_depth = 1/);
  assert.match(merged.text, /\[other\]\nenabled = true/);
});


test("config merge supports commented tables, quoted keys, and dotted agent keys", () => {
  const existing = `"model" = "gpt-5.6-sol"\nagents.max_depth = 1\n\n[other] # note\nenabled = true\n`;
  const snippet = `model = "gpt-5.6-sol"\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n`;
  const merged = mergeConfig(existing, snippet, false);

  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.text, /^"model" = "gpt-5\.6-sol"$/m);
  assert.match(merged.text, /^agents\.max_depth = 1$/m);
  assert.match(merged.text, /^agents\.max_threads = 6$/m);
  assert.doesNotMatch(merged.text, /^\[agents\]$/m);
  assert.match(merged.text, /^\[other\] # note$/m);
});


test("config merge rejects inline agent tables", () => {
  const existing = `agents = { max_depth = 1 }\n`;
  const snippet = `[agents]\nmax_threads = 6\nmax_depth = 1\n`;
  const merged = mergeConfig(existing, snippet, true);

  assert.deepEqual(merged.conflicts, [
    "config.toml uses an inline agents table that cannot be merged safely",
  ]);
  assert.equal(merged.text, existing);
  assert.equal(merged.changed, false);
});


test("config merge preserves unrelated values and gates replacements", () => {
  const existing = `# personal\nmodel = "other" # keep comment\ncustom = true\n\n[agents]\nmax_threads = 2\n\n[unrelated]\nenabled = true\n`;
  const snippet = `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n`;

  const guarded = mergeConfig(existing, snippet, false);
  assert.equal(guarded.conflicts.length, 2);
  assert.equal(guarded.text, existing);
  assert.equal(guarded.changed, false);

  const forced = mergeConfig(existing, snippet, true);
  assert.deepEqual(forced.conflicts, []);
  assert.match(forced.text, /model = "gpt-5\.6-sol" # keep comment/);
  assert.match(forced.text, /model_reasoning_effort = "high"/);
  assert.match(forced.text, /\[agents\]\nmax_threads = 6\nmax_depth = 1/);
  assert.match(forced.text, /\[unrelated\]\nenabled = true/);
});


test("fresh setup is complete, executable, and idempotent", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-fresh-");
  const firstPlan = await createSetupPlan({ codexHome, payloadRoot });
  assert.deepEqual(firstPlan.conflicts, []);
  assert.equal(firstPlan.operations.length, 7);

  const applied = await applySetupPlan(firstPlan);
  assert.equal(applied.length, 7);
  await access(join(codexHome, "skills", "orchestrate-codex-agents", "SKILL.md"));
  await access(
    join(codexHome, "skills", "orchestrate-codex-agents", "scripts", "install.py"),
    constants.X_OK,
  );
  assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /luna_fast/);
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /max_depth = 1/);

  const secondPlan = await createSetupPlan({ codexHome, payloadRoot });
  assert.deepEqual(secondPlan.conflicts, []);
  assert.equal(secondPlan.operations.length, 0);
  assert.equal(secondPlan.current.length, 7);
});


test("differing agent files require force and receive backups", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-conflict-");
  await applySetupPlan(await createSetupPlan({ codexHome, payloadRoot }));
  const agentPath = join(codexHome, "agents", "luna_fast.toml");
  await writeFile(agentPath, "custom agent\n", "utf8");

  const guarded = await createSetupPlan({ codexHome, payloadRoot });
  assert.equal(guarded.conflicts.length, 1);
  assert.match(guarded.conflicts[0].label, /luna_fast/);

  const forced = await createSetupPlan({ codexHome, payloadRoot, force: true });
  assert.deepEqual(forced.conflicts, []);
  await applySetupPlan(forced);
  assert.notEqual(await readFile(agentPath, "utf8"), "custom agent\n");
  const agentFiles = await readdir(join(codexHome, "agents"));
  assert.ok(agentFiles.some((name) => name.startsWith("luna_fast.toml.bak-")));
});


test("setup rolls back earlier changes when a later operation fails", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-rollback-");
  const existingTarget = join(codexHome, "existing.txt");
  await writeFile(existingTarget, "original\n", "utf8");

  const plan = {
    codexHome,
    conflicts: [],
    operations: [
      {
        action: "update",
        kind: "write",
        label: "existing file",
        target: existingTarget,
        content: "replacement\n",
      },
      {
        action: "create",
        kind: "copy",
        label: "missing payload",
        source: join(codexHome, "missing-source"),
        target: join(codexHome, "new-target"),
      },
    ],
  };

  await assert.rejects(applySetupPlan(plan), /ENOENT/);
  assert.equal(await readFile(existingTarget, "utf8"), "original\n");
  assert.deepEqual(await readdir(codexHome), ["existing.txt"]);
});


test("CLI supports non-interactive setup and status", async (t) => {
  const codexHome = await temporaryDirectory(t, "codex-orchestration-cli-");
  await chmod(executable, 0o755);
  const dryRun = spawnSync(
    process.execPath,
    [executable, "setup", "--codex-home", codexHome, "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run complete; no files changed/);
  assert.deepEqual(await readdir(codexHome), []);

  const unconfirmed = spawnSync(
    process.execPath,
    [executable, "setup", "--codex-home", codexHome],
    { encoding: "utf8" },
  );
  assert.equal(unconfirmed.status, 2);
  assert.match(unconfirmed.stderr, /non-interactive setup requires --yes/);
  assert.deepEqual(await readdir(codexHome), []);

  const setup = spawnSync(
    process.execPath,
    [executable, "setup", "--codex-home", codexHome, "--yes"],
    { encoding: "utf8" },
  );
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Applied 7 change/);

  const status = spawnSync(
    process.execPath,
    [executable, "status", "--codex-home", codexHome],
    { encoding: "utf8" },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /is current/);
});
