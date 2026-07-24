import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  handleSessionStart,
  handlePreToolUse,
  handleSubagentStart,
  handleUserPromptSubmit,
  parseOrchestrationCommand,
} from "../hooks/lib/handlers.js";
import {
  configPath,
  legacyConfigPath,
  readDefaultMode,
  readSessionMode,
  readWorkerObservations,
  writeDefaultMode,
  writeSessionMode,
} from "../hooks/lib/state.js";
import { isHookInput } from "../hooks/lib/schema.js";
import type { HookOutput, HookSpecificOutput } from "../hooks/lib/io.js";
import type {
  PreToolUseCommandOutput,
  PreToolUseHookSpecificOutputWire,
} from "../hooks/generated/pre-tool-use-output.js";
import type { Mode } from "../hooks/lib/state.js";


const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compiledHooksRoot = join(packageRoot, "dist", "hooks");


interface Fixture {
  root: string;
  environment: NodeJS.ProcessEnv & {
    CODEX_HOME: string;
    PLUGIN_DATA: string;
    PLUGIN_ROOT: string;
  };
}


type ContextHookOutput = HookOutput & {
  systemMessage: string;
  hookSpecificOutput: HookSpecificOutput & { additionalContext: string };
};


interface RoutedInput extends Record<string, unknown> {
  task_name?: string;
  message?: string;
  items?: Array<{ type: string; text: string }>;
}


function requireContextOutput(output: HookOutput | null): ContextHookOutput {
  assert.ok(output?.systemMessage);
  assert.ok(output.hookSpecificOutput?.additionalContext);
  return output as ContextHookOutput;
}


function requireControlOutput(output: HookOutput | null): HookOutput & {
  systemMessage: string;
  stopReason: string;
} {
  assert.ok(output?.systemMessage);
  assert.ok(output.stopReason);
  return output as HookOutput & { systemMessage: string; stopReason: string };
}


type RoutedHookOutput = PreToolUseCommandOutput & {
  hookSpecificOutput: PreToolUseHookSpecificOutputWire & {
    updatedInput: RoutedInput;
  };
};


function requireRoutedOutput(output: HookOutput | null): RoutedHookOutput {
  assert.equal(output?.hookSpecificOutput?.hookEventName, "PreToolUse");
  const routed = output as RoutedHookOutput;
  assert.ok(routed.hookSpecificOutput.updatedInput);
  return routed;
}


function requireUpdatedInput(output: HookOutput | null): RoutedInput {
  return requireRoutedOutput(output).hookSpecificOutput.updatedInput;
}


async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    CODEX_HOME: join(root, "codex"),
    PLUGIN_DATA: join(root, "plugin-data"),
    PLUGIN_ROOT: packageRoot,
  };
  return { root, environment };
}


test("SessionStart supports all four modes and persists session state", async (t) => {
  for (const mode of ["off", "lite", "full", "ultra"] as const satisfies readonly Mode[]) {
    const { environment } = await fixture(t);
    await writeDefaultMode(mode, environment);
    const output = await handleSessionStart(
      { session_id: `session-${mode}`, source: "startup" },
      environment,
    );
    assert.equal(await readSessionMode(`session-${mode}`, environment), mode);
    if (mode === "off") {
      assert.equal(output, null);
    } else {
      const contextOutput = requireContextOutput(output);
      assert.equal(contextOutput.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(
        contextOutput.hookSpecificOutput.additionalContext,
        new RegExp(`MODE: ${mode.toUpperCase()}`),
      );
      assert.match(
        contextOutput.hookSpecificOutput.additionalContext,
        /canonical `orchestrator`/,
      );
      assert.match(
        contextOutput.hookSpecificOutput.additionalContext,
        /VIRTUAL WORKER ROUTING/,
      );
    }
  }
});


test("persistent defaults live in plugin data and can fall back to a legacy config", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("lite", environment);
  assert.equal(configPath(environment), join(environment.PLUGIN_DATA, "config.json"));
  assert.equal(JSON.parse(await readFile(configPath(environment), "utf8")).defaultMode, "lite");

  await rm(configPath(environment));
  const legacy = legacyConfigPath(environment);
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(
    legacy,
    `${JSON.stringify({ schemaVersion: 1, defaultMode: "ultra" })}\n`,
    "utf8",
  );
  assert.equal(await readDefaultMode(environment), "ultra");
});


test("resume and compact preserve session mode while clear uses the current default", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("full", environment);
  await handleSessionStart({ session_id: "same", source: "startup" }, environment);
  await writeDefaultMode("lite", environment);

  const resumed = requireContextOutput(await handleSessionStart(
    { session_id: "same", source: "resume" },
    environment,
  ));
  assert.match(resumed.hookSpecificOutput.additionalContext, /MODE: FULL/);
  const compacted = requireContextOutput(await handleSessionStart(
    { session_id: "same", source: "compact" },
    environment,
  ));
  assert.match(compacted.hookSpecificOutput.additionalContext, /MODE: FULL/);
  const cleared = requireContextOutput(await handleSessionStart(
    { session_id: "same", source: "clear" },
    environment,
  ));
  assert.match(cleared.hookSpecificOutput.additionalContext, /MODE: LITE/);
});


test("environment default mode overrides the persistent config", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("ultra", environment);
  const overridden = { ...environment, CODEX_ORCHESTRATION_DEFAULT_MODE: "lite" };
  const output = requireContextOutput(await handleSessionStart(
    { session_id: "override", source: "startup" },
    overridden,
  ));
  assert.match(output.hookSpecificOutput.additionalContext, /MODE: LITE/);
});


test("command parser accepts only exact orchestration commands", () => {
  assert.deepEqual(parseOrchestrationCommand("$corch"), { action: "status" });
  assert.deepEqual(parseOrchestrationCommand("$corch status"), { action: "status" });
  assert.deepEqual(
    parseOrchestrationCommand("$corch ultra"),
    { action: "mode", mode: "ultra" },
  );
  assert.deepEqual(
    parseOrchestrationCommand("$corch default lite"),
    { action: "default", mode: "lite" },
  );
  assert.deepEqual(parseOrchestrationCommand("corch status"), { action: "status" });
  assert.deepEqual(parseOrchestrationCommand("@corch off"), {
    action: "mode",
    mode: "off",
  });
  assert.deepEqual(parseOrchestrationCommand("/corch full"), {
    action: "mode",
    mode: "full",
  });
  for (const prompt of [
    "please $corch full",
    "$corch FULL",
    "$corch full now",
    "$corch default",
    "/orchestra full",
    " $corch full",
    "$corch full ",
    "$corch full\n",
    "ordinary prompt",
    "",
  ]) {
    assert.equal(parseOrchestrationCommand(prompt), null, prompt);
  }
});


test("ordinary prompts are silent and exact controls report or change state", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("full", environment);
  await writeSessionMode("session", "full", environment);
  assert.equal(
    await handleUserPromptSubmit(
      { session_id: "session", prompt: "build this" },
      environment,
    ),
    null,
  );

  const status = requireControlOutput(await handleUserPromptSubmit(
    { session_id: "session", prompt: "$corch status" },
    environment,
  ));
  assert.equal(status.hookSpecificOutput, undefined);
  assert.equal(status.continue, false);
  assert.match(status.systemMessage, /session=full, default=full/);
  assert.match(status.systemMessage, /worker-selection=auto/);
  assert.match(status.systemMessage, /Recent workers: none recorded/);
  assert.match(status.systemMessage, /Reasoning effort is not exposed to hooks/);
  assert.equal(status.stopReason, status.systemMessage);

  const changed = requireControlOutput(await handleUserPromptSubmit(
    { session_id: "session", prompt: "$corch lite" },
    environment,
  ));
  assert.equal(await readSessionMode("session", environment), "lite");
  assert.equal(changed.continue, false);
  assert.equal(changed.stopReason, changed.systemMessage);
  const changedContext = requireContextOutput(changed);
  assert.match(changedContext.hookSpecificOutput.additionalContext, /supersedes earlier/);
  assert.match(changedContext.hookSpecificOutput.additionalContext, /MODE: LITE/);

  const defaultChanged = requireControlOutput(await handleUserPromptSubmit(
    { session_id: "session", prompt: "$corch default ultra" },
    environment,
  ));
  assert.equal(defaultChanged.continue, false);
  assert.equal(defaultChanged.stopReason, defaultChanged.systemMessage);
  assert.equal(await readDefaultMode(environment), "ultra");
  assert.equal(await readSessionMode("session", environment), "lite");
});


test("hook commands are portable, fail open, and bounded to five seconds", async () => {
  const config = JSON.parse(
    await readFile(join(packageRoot, "hooks", "hooks.json"), "utf8"),
  ) as {
    hooks: Record<string, Array<{ hooks: Array<{
      timeout: number;
      command: string;
      commandWindows: string;
    }> }>>;
  };
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.timeout, 5);
        assert.match(hook.command, /^command -v node /);
        assert.match(hook.command, /\|\| true$/);
        assert.doesNotMatch(hook.commandWindows, /powershell/i);
        assert.match(hook.commandWindows, /^if \(Get-Command node /);
        assert.match(hook.commandWindows, /\$env:PLUGIN_ROOT/);
        assert.match(hook.commandWindows, /; exit 0$/);
      }
    }
  }
  assert.match(
    await readFile(join(compiledHooksRoot, "lib", "io.js"), "utf8"),
    /const INPUT_TIMEOUT_MS = 1000;/,
  );
});


test("hook input validation follows the pinned schema and permits additive fields", () => {
  const input = {
    cwd: packageRoot,
    hook_event_name: "PreToolUse",
    model: "auto-selected-model",
    permission_mode: "default",
    session_id: "schema-test",
    tool_input: {
      task_name: "explore__schema_test",
      message: "inspect the schema",
    },
    tool_name: "spawn_agent",
    tool_use_id: "tool-schema-test",
    transcript_path: null,
    turn_id: "turn-schema-test",
    future_compatible_field: true,
  };
  assert.equal(isHookInput(input, "PreToolUse"), true);
  assert.equal(
    isHookInput({ ...input, permission_mode: "unsupported" }, "PreToolUse"),
    false,
  );
  assert.equal(
    isHookInput({ ...input, hook_event_name: "SessionStart" }, "PreToolUse"),
    false,
  );
  const missingToolUseId = { ...input, tool_use_id: undefined };
  assert.equal(isHookInput(missingToolUseId, "PreToolUse"), false);
});


test("off mode does not inject a contract into ordinary built-in workers", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("off", environment);
  await writeSessionMode("parent", "off", environment);
  assert.equal(
    await handleSubagentStart(
      {
        session_id: "parent",
        agent_id: "worker-off",
        agent_type: "worker",
        model: "auto-selected-model",
        turn_id: "turn-off",
      },
      environment,
    ),
    null,
  );
  assert.deepEqual(
    (await readWorkerObservations("parent", environment)).map(({ agentId, model }) => (
      { agentId, model }
    )),
    [{ agentId: "worker-off", model: "auto-selected-model" }],
  );
});


test("PreToolUse resolves virtual roles while leaving model and effort automatic", async (t) => {
  const { environment } = await fixture(t);
  await writeSessionMode("parent", "full", environment);

  for (const name of ["lookup", "explore", "build", "review"]) {
    const taskName = `${name}__bounded_scope`;
    const output = await handlePreToolUse(
      {
        tool_input: {
          task_name: taskName,
          message: "bounded scope",
          extra_field: "preserved",
        },
      },
      environment,
    );
    assert.equal(output?.continue, undefined);
    assert.equal(output?.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "allow");
    const updated = requireUpdatedInput(output);
    assert.equal(updated.task_name, taskName);
    assert.equal("agent_type" in updated, false);
    assert.equal(updated.extra_field, "preserved");
    assert.equal("model" in updated, false);
    assert.equal("reasoning_effort" in updated, false);
    assert.match(updated.message ?? "", new RegExp(`Role: ${name}\\.`));
    assert.match(
      updated.message ?? "",
      /leaves model and reasoning effort unpinned by default/,
    );
    assert.match(updated.message ?? "", /ORIGINAL ASSIGNMENT\nbounded scope$/);
  }
});


test("PreToolUse preserves explicit native overrides", async (t) => {
  const { environment } = await fixture(t);
  const output = await handlePreToolUse(
    {
      tool_input: {
        task_name: "lookup__pinned_task",
        message: "explicitly pinned task",
        agent_type: "configured_native_role",
        model: "user-selected-model",
        reasoning_effort: "xhigh",
        service_tier: "priority",
      },
    },
    environment,
  );
  const updated = requireUpdatedInput(output);
  assert.equal(updated.model, "user-selected-model");
  assert.equal(updated.reasoning_effort, "xhigh");
  assert.equal(updated.agent_type, "configured_native_role");
  assert.equal(updated.service_tier, "priority");
});


test("PreToolUse can prepend a virtual role to structured v1 items", async (t) => {
  const { environment } = await fixture(t);
  const original = [{ type: "text", text: "inspect the logs" }];
  const output = await handlePreToolUse(
    { tool_input: { task_name: "explore__inspect_logs", items: original } },
    environment,
  );
  const updated = requireUpdatedInput(output);
  assert.equal(updated.task_name, "explore__inspect_logs");
  assert.equal("agent_type" in updated, false);
  assert.ok(updated.items);
  assert.match(updated.items[0]?.text ?? "", /Role: explore\./);
  assert.deepEqual(updated.items.slice(1), original);
  assert.equal("message" in updated, false);
});


test("PreToolUse is silent for ordinary, unknown, and malformed task names", async (t) => {
  const { environment } = await fixture(t);
  await writeSessionMode("parent", "full", environment);
  for (const taskName of [
    "default",
    "worker",
    "explorer",
    "explore__",
    "explore___task",
    "explore__two__parts",
    "unknown__task",
    "toString__task",
    "__proto____task",
  ]) {
    assert.equal(
      await handlePreToolUse(
        { tool_input: { task_name: taskName } },
        environment,
      ),
      null,
    );
  }
  assert.equal(
    await handlePreToolUse({ tool_input: { message: "ordinary" } }, environment),
    null,
  );
  assert.equal(
    await handlePreToolUse({
      tool_input: {
        task_name: "explore__invalid_types",
        message: 42,
      },
    }, environment),
    null,
  );
});


test("off mode keeps explicitly invoked virtual workers usable", async (t) => {
  const { environment } = await fixture(t);
  await writeSessionMode("parent", "off", environment);
  const resolved = await handlePreToolUse(
    {
      tool_input: {
        task_name: "build__bounded_fix",
        message: "make the bounded fix",
      },
    },
    environment,
  );
  const updated = requireUpdatedInput(resolved);
  assert.equal(updated.task_name, "build__bounded_fix");
  assert.equal("agent_type" in updated, false);
  assert.equal("model" in updated, false);
  assert.equal("reasoning_effort" in updated, false);
  assert.match(updated.message ?? "", /Role: build\./);
  assert.match(updated.message ?? "", /# Worker Contract/);
  assert.match(updated.message ?? "", /ORIGINAL ASSIGNMENT\nmake the bounded fix$/);
  const worker = await handleSubagentStart(
    {
      session_id: "parent",
      agent_id: "worker-explicit",
      agent_type: "default",
      model: "auto-selected-model",
      turn_id: "turn-explicit",
    },
    environment,
  );
  assert.equal(worker, null);
});


test("SubagentStart reports the selected model but does not infer a virtual role", async (t) => {
  const { environment } = await fixture(t);
  await writeSessionMode("parent", "full", environment);
  const worker = requireContextOutput(await handleSubagentStart(
    {
      session_id: "parent",
      agent_id: "worker-1",
      agent_type: "worker",
      model: "auto-selected-model",
      turn_id: "turn-1",
    },
    environment,
  ));
  assert.match(worker.hookSpecificOutput.additionalContext, /auto-selected-model/);
  assert.match(worker.hookSpecificOutput.additionalContext, /does not pin/);
  assert.match(worker.hookSpecificOutput.additionalContext, /parent orchestrator assignment/);
  assert.doesNotMatch(worker.hookSpecificOutput.additionalContext, /VIRTUAL ROLE:/);
  assert.match(worker.systemMessage, /effort is not exposed to hooks/);
});


test("status lists recent worker models from the current session newest first", async (t) => {
  const { environment } = await fixture(t);
  await writeSessionMode("parent", "full", environment);
  for (let index = 1; index <= 6; index += 1) {
    await handleSubagentStart(
      {
        session_id: "parent",
        agent_id: `worker-${index}`,
        agent_type: index % 2 === 0 ? "worker" : "explorer",
        model: `gpt-${index}`,
        turn_id: `turn-${index}`,
      },
      environment,
    );
  }
  await handleSubagentStart(
    {
      session_id: "other",
      agent_id: "worker-other",
      agent_type: "worker",
      model: "gpt-other",
      turn_id: "turn-other",
    },
    environment,
  );

  const observations = await readWorkerObservations("parent", environment);
  assert.deepEqual(
    observations.map(({ agentId, agentType, model, turnId }) => ({
      agentId,
      agentType,
      model,
      turnId,
    })),
    [
      {
        agentId: "worker-6",
        agentType: "worker",
        model: "gpt-6",
        turnId: "turn-6",
      },
      {
        agentId: "worker-5",
        agentType: "explorer",
        model: "gpt-5",
        turnId: "turn-5",
      },
      {
        agentId: "worker-4",
        agentType: "worker",
        model: "gpt-4",
        turnId: "turn-4",
      },
      {
        agentId: "worker-3",
        agentType: "explorer",
        model: "gpt-3",
        turnId: "turn-3",
      },
      {
        agentId: "worker-2",
        agentType: "worker",
        model: "gpt-2",
        turnId: "turn-2",
      },
    ],
  );

  const status = requireControlOutput(await handleUserPromptSubmit(
    { session_id: "parent", prompt: "$corch status" },
    environment,
  ));
  assert.match(status.systemMessage, /Recent workers \(newest first\):/);
  assert.ok(status.systemMessage.indexOf("model=gpt-6")
    < status.systemMessage.indexOf("model=gpt-5"));
  assert.doesNotMatch(status.systemMessage, /model=gpt-1(?:\s|$)/);
  assert.doesNotMatch(status.systemMessage, /gpt-other/);
  assert.match(status.systemMessage, /Reasoning effort is not exposed to hooks/);
});


test("a corrupt observation line does not hide valid worker models", async (t) => {
  const { environment } = await fixture(t);
  await handleSubagentStart(
    {
      session_id: "parent",
      agent_id: "worker-valid",
      agent_type: "worker",
      model: "gpt-valid",
      turn_id: "turn-valid",
    },
    environment,
  );
  const observationDirectory = join(environment.PLUGIN_DATA, "worker-observations");
  const observationFiles = await readdir(observationDirectory);
  assert.equal(observationFiles.length, 1);
  const observationFile = observationFiles[0];
  assert.ok(observationFile);
  await appendFile(join(observationDirectory, observationFile), "{incomplete\n", "utf8");

  const observations = await readWorkerObservations("parent", environment);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.model, "gpt-valid");
  const status = requireControlOutput(await handleUserPromptSubmit(
    { session_id: "parent", prompt: "$corch status" },
    environment,
  ));
  assert.match(status.systemMessage, /model=gpt-valid/);
});


test("missing or corrupt session state falls back to the persistent default", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("ultra", environment);
  const missing = requireContextOutput(await handleSessionStart(
    { session_id: "missing", source: "resume" },
    environment,
  ));
  assert.match(missing.hookSpecificOutput.additionalContext, /MODE: ULTRA/);

  await writeSessionMode("corrupt", "lite", environment);
  const sessions = join(environment.PLUGIN_DATA, "sessions");
  const candidates = await readdir(sessions);
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    await writeFile(join(sessions, candidate), "{broken", "utf8");
  }
  const corrupt = requireContextOutput(await handleSessionStart(
    { session_id: "corrupt", source: "resume" },
    environment,
  ));
  assert.match(corrupt.hookSpecificOutput.additionalContext, /MODE: ULTRA/);
});


test("hook output stays comfortably below the model-visible output cap", async (t) => {
  const { environment } = await fixture(t);
  await writeDefaultMode("ultra", environment);
  const session = requireContextOutput(await handleSessionStart(
    { session_id: "size", source: "startup" },
    environment,
  ));
  const worker = requireContextOutput(await handleSubagentStart(
    {
      session_id: "size",
      agent_id: "worker-size",
      agent_type: "default",
      model: "auto-selected-model",
      turn_id: "turn-size",
    },
    environment,
  ));
  assert.ok(JSON.stringify(session).length < 8000);
  assert.ok(JSON.stringify(worker).length < 8000);
  assert.ok(session.hookSpecificOutput.additionalContext.split(/\s+/).length < 1000);
  assert.ok(worker.hookSpecificOutput.additionalContext.split(/\s+/).length < 1000);
});


test("entrypoint fails open on malformed stdin", () => {
  const result = spawnSync(
    process.execPath,
    [join(compiledHooksRoot, "session-start.js")],
    {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, PLUGIN_ROOT: packageRoot },
      timeout: 2000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});


test("PreToolUse entrypoint routes the current spawn schema through task_name", async (t) => {
  const { environment } = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [join(compiledHooksRoot, "pre-tool-use.js")],
    {
      input: JSON.stringify({
        cwd: packageRoot,
        hook_event_name: "PreToolUse",
        model: "auto-selected-model",
        permission_mode: "default",
        session_id: "entrypoint",
        tool_name: "spawn_agent",
        tool_use_id: "tool-entrypoint",
        tool_input: {
          task_name: "explore__inspect_only",
          message: "inspect only",
        },
        transcript_path: null,
        turn_id: "turn-entrypoint",
      }),
      encoding: "utf8",
      env: { ...process.env, ...environment },
      timeout: 2000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as HookOutput;
  const routedOutput = requireRoutedOutput(output);
  const updatedInput = requireUpdatedInput(output);
  assert.equal(routedOutput.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(
    updatedInput.task_name,
    "explore__inspect_only",
  );
  assert.equal("agent_type" in updatedInput, false);
  assert.equal("model" in updatedInput, false);
  assert.equal("reasoning_effort" in updatedInput, false);
  assert.match(updatedInput.message ?? "", /Role: explore\./);
  assert.match(updatedInput.message ?? "", /ORIGINAL ASSIGNMENT\ninspect only$/);
});
