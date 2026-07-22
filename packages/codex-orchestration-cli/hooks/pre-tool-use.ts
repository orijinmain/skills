#!/usr/bin/env node

import { handlePreToolUse } from "./lib/handlers.js";
import { runHook } from "./lib/io.js";


await runHook("PreToolUse", handlePreToolUse);
