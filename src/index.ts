#!/usr/bin/env node
import * as os from "node:os";
import * as v8 from "node:v8";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { program } from "commander";

// Bulk indexing (mgrep watch) reads hundreds of files simultaneously, computes
// embedding vectors (Float32Array, off-heap), and drives LanceDB Arrow writes.
// The default V8 heap ceiling (~4 GB) is too low for large document repositories.
// Cap at 8 GB to avoid starving other processes on machines with less RAM.
const totalMb = Math.round(os.totalmem() / 1024 / 1024);
const heapLimitMb = Math.min(Math.floor(totalMb * 0.25), 8192);
v8.setFlagsFromString(`--max-old-space-size=${heapLimitMb}`);
import { validate } from "./commands/login.js";
import { rules } from "./commands/rules.js";
import { search } from "./commands/search.js";
import { watch } from "./commands/watch.js";
import { watchMcp } from "./commands/watch_mcp.js";
import {
  installClaudeCode,
  uninstallClaudeCode,
} from "./install/claude-code.js";
import { installCodex, uninstallCodex } from "./install/codex.js";
import { installDroid, uninstallDroid } from "./install/droid.js";
import { installOpencode, uninstallOpencode } from "./install/opencode.js";
import { setupLogger } from "./lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

setupLogger();

program
  .version(
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), {
        encoding: "utf-8",
      }),
    ).version,
  )
  .option(
    "--store <string>",
    "The store to use",
    process.env.MGREP_STORE || "mgrep",
  );

program.addCommand(search, { isDefault: true });
program.addCommand(rules);
program.addCommand(watch);
program.addCommand(installClaudeCode);
program.addCommand(uninstallClaudeCode);
program.addCommand(installCodex);
program.addCommand(uninstallCodex);
program.addCommand(installDroid);
program.addCommand(uninstallDroid);
program.addCommand(installOpencode);
program.addCommand(uninstallOpencode);
program.addCommand(validate);
program.addCommand(watchMcp);

program.parse();
