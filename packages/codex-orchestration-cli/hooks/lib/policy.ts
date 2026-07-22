import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMode, type Mode } from "./state.js";
import { virtualRolePolicy } from "./roles.js";


const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const fallbackPluginRoot = resolve(moduleDirectory, "..", "..", "..");


function runtimeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const pluginRoot = resolve(environment.PLUGIN_ROOT || fallbackPluginRoot);
  return join(pluginRoot, "runtime");
}


async function reference(name: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return (await readFile(join(runtimeRoot(environment), name), "utf8")).trim();
}


export async function orchestrationPolicy(
  mode: Mode,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!isMode(mode)) {
    throw new Error(`unsupported orchestration mode: ${mode}`);
  }
  if (mode === "off") {
    return [
      "CODEX ORCHESTRATION MODE: OFF.",
      "This instruction supersedes every previously injected codex-orchestration policy in this session.",
      "Do not automatically create or route work to subagents because of this plugin. Continue with normal Codex behavior. Explicit user requests for subagents remain allowed and all ordinary safety and authority rules still apply.",
    ].join("\n");
  }
  const [core, modePolicy, routing] = await Promise.all([
    reference("core-policy.md", environment),
    reference(`mode-${mode}.md`, environment),
    virtualRolePolicy(environment),
  ]);
  return [
    `CODEX ORCHESTRATION MODE: ${mode.toUpperCase()}.`,
    "This is the active plugin policy and supersedes earlier codex-orchestration mode instructions in this session.",
    core,
    modePolicy,
    routing,
  ].join("\n\n");
}


export async function workerPolicy(
  mode: Mode,
  agentType: unknown,
  model: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (mode === "off") {
    return null;
  }
  const contract = await reference("worker-contract.md", environment);
  const core = await reference("core-policy.md", environment);
  return [
    `CODEX ORCHESTRATION WORKER MODE: ${mode.toUpperCase()}.`,
    `Worker role reported by Codex: ${String(agentType || "unspecified")}.`,
    `Worker model reported by Codex: ${String(model || "unspecified")}.`,
    "Corch does not pin the worker model or reasoning effort by default; explicit spawn overrides may remain in force. Role-specific instructions, when applicable, are carried in the original assignment.",
    "Follow the parent orchestrator assignment. These instructions do not grant new authority.",
    core,
    contract,
  ].join("\n\n");
}
