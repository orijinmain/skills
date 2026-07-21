#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDirectory, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const source = join(repositoryRoot, "skills", "orchestrate-codex-agents");
const distRoot = join(packageRoot, "dist");
const destination = join(distRoot, "orchestrate-codex-agents");

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (path) => !path.includes("__pycache__") && !path.endsWith(".pyc"),
});

console.log(`Built payload: ${destination}`);
