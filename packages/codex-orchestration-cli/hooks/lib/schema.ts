import type { PreToolUseCommandInput } from "../generated/pre-tool-use-input.js";
import type { PreToolUseCommandOutput } from "../generated/pre-tool-use-output.js";
import type { SessionStartCommandInput } from "../generated/session-start-input.js";
import type { SessionStartCommandOutput } from "../generated/session-start-output.js";
import type { SubagentStartCommandInput } from "../generated/subagent-start-input.js";
import type { SubagentStartCommandOutput } from "../generated/subagent-start-output.js";
import type { UserPromptSubmitCommandInput } from "../generated/user-prompt-submit-input.js";
import type { UserPromptSubmitCommandOutput } from "../generated/user-prompt-submit-output.js";

export type HookEventName =
  | "SessionStart"
  | "SubagentStart"
  | "PreToolUse"
  | "UserPromptSubmit";

export interface HookInputMap {
  SessionStart: SessionStartCommandInput;
  SubagentStart: SubagentStartCommandInput;
  PreToolUse: PreToolUseCommandInput;
  UserPromptSubmit: UserPromptSubmitCommandInput;
}

export interface HookOutputMap {
  SessionStart: SessionStartCommandOutput;
  SubagentStart: SubagentStartCommandOutput;
  PreToolUse: PreToolUseCommandOutput;
  UserPromptSubmit: UserPromptSubmitCommandOutput;
}

export type HookInput = HookInputMap[HookEventName];
export type HookOutput = HookOutputMap[HookEventName];
export type HookSpecificOutput = NonNullable<HookOutput["hookSpecificOutput"]>;

export type HookHandler<Event extends HookEventName> = (
  input: HookInputMap[Event],
  environment: NodeJS.ProcessEnv,
) => Promise<HookOutputMap[Event] | null>;

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
const SESSION_START_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function hasCommonFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.cwd === "string"
    && typeof value.model === "string"
    && typeof value.session_id === "string"
    && typeof value.permission_mode === "string"
    && PERMISSION_MODES.has(value.permission_mode)
    && isNullableString(value.transcript_path)
  );
}

/**
 * Validate the required fields from the pinned Codex schemas without rejecting
 * unknown fields added by a future compatible Codex release.
 */
export function isHookInput<Event extends HookEventName>(
  value: unknown,
  eventName: Event,
): value is HookInputMap[Event] {
  if (
    !isRecord(value)
    || value.hook_event_name !== eventName
    || !hasCommonFields(value)
  ) {
    return false;
  }

  switch (eventName) {
    case "SessionStart":
      return typeof value.source === "string" && SESSION_START_SOURCES.has(value.source);
    case "SubagentStart":
      return (
        typeof value.agent_id === "string"
        && typeof value.agent_type === "string"
        && typeof value.turn_id === "string"
      );
    case "PreToolUse":
      return (
        typeof value.tool_name === "string"
        && typeof value.tool_use_id === "string"
        && typeof value.turn_id === "string"
        && Object.hasOwn(value, "tool_input")
      );
    case "UserPromptSubmit":
      return typeof value.prompt === "string" && typeof value.turn_id === "string";
  }
}
