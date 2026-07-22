import type { PreToolUseCommandInput } from "../generated/pre-tool-use-input.js";
import type { PreToolUseCommandOutput } from "../generated/pre-tool-use-output.js";
import type { SessionStartCommandInput } from "../generated/session-start-input.js";
import type { SessionStartCommandOutput } from "../generated/session-start-output.js";
import type { SubagentStartCommandInput } from "../generated/subagent-start-input.js";
import type { SubagentStartCommandOutput } from "../generated/subagent-start-output.js";
import type { UserPromptSubmitCommandInput } from "../generated/user-prompt-submit-input.js";
import type { UserPromptSubmitCommandOutput } from "../generated/user-prompt-submit-output.js";
import {
  preToolUseOutput,
  sessionStartOutput,
  subagentStartOutput,
  userPromptControlOutput,
} from "./io.js";
import { orchestrationPolicy, workerPolicy } from "./policy.js";
import { rewriteVirtualAgentInput } from "./roles.js";
import {
  isMode,
  type Mode,
  readDefaultMode,
  readSessionMode,
  writeDefaultMode,
  writeSessionMode,
} from "./state.js";


type SessionStartHandlerInput = Pick<SessionStartCommandInput, "session_id" | "source">;
type SubagentStartHandlerInput = Pick<
  SubagentStartCommandInput,
  "session_id" | "agent_type" | "model"
>;
type PreToolUseHandlerInput = Pick<PreToolUseCommandInput, "tool_input">;
type UserPromptSubmitHandlerInput = Pick<
  UserPromptSubmitCommandInput,
  "session_id" | "prompt"
>;


function sourceStartsFresh(source: SessionStartCommandInput["source"]): boolean {
  return source === "startup" || source === "clear";
}


export async function handleSessionStart(
  input: SessionStartHandlerInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SessionStartCommandOutput | null> {
  const defaultMode = await readDefaultMode(environment);
  const existing = sourceStartsFresh(input.source)
    ? null
    : await readSessionMode(input.session_id, environment);
  const mode = existing || defaultMode;
  await writeSessionMode(
    input.session_id,
    mode,
    environment,
    existing ? "resume" : "default",
  );
  if (mode === "off") {
    return null;
  }
  return sessionStartOutput(
    await orchestrationPolicy(mode, environment),
    `Codex orchestration is active in ${mode} mode.`,
  );
}


export async function handleSubagentStart(
  input: SubagentStartHandlerInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SubagentStartCommandOutput | null> {
  const mode = (
    await readSessionMode(input.session_id, environment)
  ) || await readDefaultMode(environment);
  const policy = await workerPolicy(
    mode,
    input.agent_type,
    input.model,
    environment,
  );
  if (!policy) {
    return null;
  }
  return subagentStartOutput(
    policy,
    `Orchestration worker contract applied (${mode}; model=${input.model || "unreported"}; effort is not exposed to hooks).`,
  );
}


export async function handlePreToolUse(
  input: PreToolUseHandlerInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PreToolUseCommandOutput | null> {
  const rewritten = await rewriteVirtualAgentInput(input.tool_input, environment);
  return rewritten ? preToolUseOutput(rewritten.updatedInput) : null;
}


type OrchestrationCommand =
  | { action: "status" }
  | { action: "mode"; mode: Mode }
  | { action: "default"; mode: Mode };


export function parseOrchestrationCommand(prompt: unknown): OrchestrationCommand | null {
  const value = typeof prompt === "string" ? prompt : "";
  const match = /^(?:\$corch|@corch|\/corch|corch)(?: (status|off|lite|full|ultra|default (?:off|lite|full|ultra)))?$/.exec(value);
  if (!match || match[0] !== value) {
    return null;
  }
  const argument = match[1] || "status";
  if (argument === "status") {
    return { action: "status" };
  }
  if (isMode(argument)) {
    return { action: "mode", mode: argument };
  }
  const defaultMode = argument.slice("default ".length);
  return isMode(defaultMode) ? { action: "default", mode: defaultMode } : null;
}


export async function handleUserPromptSubmit(
  input: UserPromptSubmitHandlerInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<UserPromptSubmitCommandOutput | null> {
  const command = parseOrchestrationCommand(input.prompt);
  if (!command) {
    return null;
  }
  const defaultMode = await readDefaultMode(environment);
  const activeMode = (
    await readSessionMode(input.session_id, environment)
  ) || defaultMode;

  if (command.action === "status") {
    return userPromptControlOutput(
      null,
      `Codex orchestration: session=${activeMode}, default=${defaultMode}, worker-selection=auto. Models are reported at SubagentStart; reasoning effort is not exposed to hooks.`,
    );
  }
  if (command.action === "default") {
    await writeDefaultMode(command.mode, environment);
    const overridden = isMode(environment.CODEX_ORCHESTRATION_DEFAULT_MODE);
    const suffix = overridden
      ? ` Environment override remains ${environment.CODEX_ORCHESTRATION_DEFAULT_MODE}.`
      : "";
    return userPromptControlOutput(
      null,
      `Codex orchestration default is now ${command.mode}; the current session remains ${activeMode}.${suffix}`,
    );
  }

  await writeSessionMode(input.session_id, command.mode, environment, "command");
  return userPromptControlOutput(
    await orchestrationPolicy(command.mode, environment),
    `Codex orchestration session mode changed to ${command.mode}.`,
  );
}
