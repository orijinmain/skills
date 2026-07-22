import type { PreToolUseCommandOutput } from "../generated/pre-tool-use-output.js";
import type { SessionStartCommandOutput } from "../generated/session-start-output.js";
import type { SubagentStartCommandOutput } from "../generated/subagent-start-output.js";
import type { UserPromptSubmitCommandOutput } from "../generated/user-prompt-submit-output.js";
import {
  isHookInput,
  type HookEventName,
  type HookHandler,
  type HookOutput,
} from "./schema.js";

export type { HookOutput, HookSpecificOutput } from "./schema.js";

const INPUT_TIMEOUT_MS = 1000;


export async function readHookInput(
  stream: NodeJS.ReadStream = process.stdin,
  timeoutMs = INPUT_TIMEOUT_MS,
): Promise<unknown> {
  if (stream.readableEnded) {
    return null;
  }
  return new Promise<unknown>((resolve) => {
    let settled = false;
    let contents = "";
    const finish = (value: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.pause();
      resolve(value);
    };
    const onData = (chunk: string): void => {
      contents += chunk;
      if (contents.length > 1024 * 1024) {
        finish(null);
      }
    };
    const onEnd = (): void => {
      try {
        finish(contents.trim() ? JSON.parse(contents) : null);
      } catch {
        finish(null);
      }
    };
    const onError = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.resume();
  });
}


function baseContextOutput(
  systemMessage: string | null,
): { continue: true; systemMessage?: string } {
  const output: { continue: true; systemMessage?: string } = { continue: true };
  if (systemMessage) {
    output.systemMessage = systemMessage;
  }
  return output;
}


export function sessionStartOutput(
  additionalContext: string | null,
  systemMessage: string | null,
): SessionStartCommandOutput {
  const output: SessionStartCommandOutput = baseContextOutput(systemMessage);
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "SessionStart",
      additionalContext,
    };
  }
  return output;
}


export function subagentStartOutput(
  additionalContext: string | null,
  systemMessage: string | null,
): SubagentStartCommandOutput {
  const output: SubagentStartCommandOutput = baseContextOutput(systemMessage);
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "SubagentStart",
      additionalContext,
    };
  }
  return output;
}


export function userPromptSubmitOutput(
  additionalContext: string | null,
  systemMessage: string | null,
): UserPromptSubmitCommandOutput {
  const output: UserPromptSubmitCommandOutput = baseContextOutput(systemMessage);
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    };
  }
  return output;
}


export function userPromptControlOutput(
  additionalContext: string | null,
  systemMessage: string,
): UserPromptSubmitCommandOutput {
  const output = userPromptSubmitOutput(additionalContext, systemMessage);
  output.continue = false;
  output.stopReason = systemMessage;
  return output;
}


export function preToolUseOutput(
  updatedInput: Record<string, unknown>,
): PreToolUseCommandOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}


export async function runHook<Event extends HookEventName>(
  eventName: Event,
  handler: HookHandler<Event>,
): Promise<void> {
  try {
    const input = await readHookInput();
    if (!isHookInput(input, eventName)) {
      return;
    }
    const output = await handler(input, process.env);
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // Lifecycle hooks must never block normal Codex operation.
  }
}
