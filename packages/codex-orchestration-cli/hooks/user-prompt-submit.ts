#!/usr/bin/env node

import { handleUserPromptSubmit } from "./lib/handlers.js";
import { runHook } from "./lib/io.js";


await runHook("UserPromptSubmit", handleUserPromptSubmit);
