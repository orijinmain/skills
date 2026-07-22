#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDirectory, "..", "..");
const repositoryRoot = join(packageRoot, "..", "..");
const skillsRoot = join(packageRoot, "skills");
const runtimeRoot = join(packageRoot, "runtime");
const skillName = "corch";


async function copyPayload(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
  });
  console.log(`Built payload: ${destination}`);
}

await rm(skillsRoot, { recursive: true, force: true });
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(skillsRoot, { recursive: true });
await copyPayload(
  join(repositoryRoot, "skills", skillName),
  join(skillsRoot, skillName),
);
await copyPayload(join(repositoryRoot, "runtime"), runtimeRoot);
