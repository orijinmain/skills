#!/usr/bin/env node

import { handleSubagentStart } from "./lib/handlers.js";
import { runHook } from "./lib/io.js";


await runHook("SubagentStart", handleSubagentStart);
