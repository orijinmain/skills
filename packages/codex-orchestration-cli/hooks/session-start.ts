#!/usr/bin/env node

import { handleSessionStart } from "./lib/handlers.js";
import { runHook } from "./lib/io.js";


await runHook("SessionStart", handleSessionStart);
