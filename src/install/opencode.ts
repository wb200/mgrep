import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { parse, stringify } from "comment-json";
import { ensureAuthenticated } from "../lib/utils.js";
import { printInstallWarning } from "../lib/warning.js";

type McpEntry = {
  type: "local";
  command: string[];
  enabled: boolean;
};

type OpenCodeConfig = {
  $schema?: string;
  mcp?: Record<string, McpEntry>;
} & Record<string, unknown>;

const TOOL_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "tool",
  "mgrep.ts",
);

function resolveConfigPath(): string {
  const configDir = path.join(os.homedir(), ".config", "opencode");
  const jsonPath = path.join(configDir, "opencode.json");
  const jsoncPath = path.join(configDir, "opencode.jsonc");

  if (fs.existsSync(jsonPath)) return jsonPath;
  if (fs.existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

function parseConfigFile(filePath: string, content: string): OpenCodeConfig {
  if (!content.trim()) return {};

  try {
    return parse(content) as OpenCodeConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse config file "${filePath}": ${message}\nPlease fix the syntax error in your configuration file.`,
    );
  }
}

const TOOL_DEFINITION = `
import { tool } from "@opencode-ai/plugin"

const SKILL = \`
---
name: mgrep
description: Use mgrep for hybrid semantic local search when you know the concept but not the exact string. It complements rg, grep, ast-grep, and path-based tools.
license: Apache 2.0
---

## When to use this skill

- Use \\\`mgrep\\\` for semantic or intent-based discovery across local code and docs
- Use \\\`rg\\\` or \\\`grep\\\` for exact string and regex matches
- Use \\\`ast-grep\\\` for syntax-aware exhaustive matches

## How to use this skill

Use \\\`mgrep\\\` to search your local files. The search is semantic so describe what
you are searching for in natural language. The results is the file path and the
line range of the match.

Recommended workflow:

1. Use \\\`mgrep\\\` to find candidate files and architectural entry points
2. Use \\\`rg\\\`, \\\`grep\\\`, or \\\`ast-grep\\\` to verify exact implementation details

### Do

\\\`\\\`\\\`bash
mgrep "What code parsers are available?"  # search in the current directory
mgrep "How are chunks defined?" src/models  # search in the src/models directory
mgrep -m 10 "What is the maximum number of concurrent workers in the code parser?"  # limit the number of results to 10
rg "rateLimit" src
mgrep "Where is rate limiting configured?" src
\\\`\\\`\\\`

### Don't

\\\`\\\`\\\`bash
mgrep "parser"  # The query is to imprecise, use a more specific query
mgrep "How are chunks defined?" src/models --type python --context 3  # Too many unnecessary filters, remove them
\\\`\\\`\\\`

## Keywords
hybrid search, semantic search, code search, grep, rg, ast-grep, local search
\`;

export default tool({
  description: SKILL,
  args: {
    q: tool.schema.string().describe("The semantic search query."),
    m: tool.schema.number().default(10).describe("The number of chunks to return."),
    a: tool.schema.boolean().default(false).describe("If an answer should be generated based of the chunks. Useful for questions."),
  },
  async execute(args) {
    const result = await Bun.$\`mgrep search -m \${args.m} \${args.a ? '-a ' : ''}\${args.q}\`.text()
    return result.trim()
  },
})`;

async function installPlugin() {
  try {
    fs.mkdirSync(path.dirname(TOOL_PATH), { recursive: true });

    const existingToolDefinition = fs.existsSync(TOOL_PATH)
      ? fs.readFileSync(TOOL_PATH, "utf-8")
      : null;
    if (existingToolDefinition !== TOOL_DEFINITION) {
      fs.writeFileSync(TOOL_PATH, TOOL_DEFINITION);
      console.log("Successfully installed the mgrep tool");
    } else {
      console.log("The mgrep tool is already up to date");
    }

    const configPath = resolveConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, stringify({}, null, 2));
    }
    const configContent = fs.readFileSync(configPath, "utf-8");
    const configJson = parseConfigFile(configPath, configContent);
    if (!configJson.$schema) {
      configJson.$schema = "https://opencode.ai/config.json";
    }
    if (!configJson.mcp) {
      configJson.mcp = {};
    }
    configJson.mcp.mgrep = {
      type: "local",
      command: ["mgrep", "mcp"],
      enabled: true,
    };
    fs.writeFileSync(configPath, stringify(configJson, null, 2));
    console.log("Successfully installed the mgrep tool in the OpenCode agent");

    printInstallWarning("OpenCode", "mgrep uninstall-opencode");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error installing tool: ${errorMessage}`);
    console.error((error as Error)?.stack);
    process.exit(1);
  }
}

async function uninstallPlugin() {
  try {
    if (fs.existsSync(TOOL_PATH)) {
      fs.unlinkSync(TOOL_PATH);
      console.log(
        "Successfully removed the mgrep tool from the OpenCode agent",
      );
    } else {
      console.log("The mgrep tool is not installed in the OpenCode agent");
    }

    const configPath = resolveConfigPath();
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, "utf-8");
      const configJson = parseConfigFile(configPath, configContent);
      if (configJson.mcp) {
        delete configJson.mcp.mgrep;
      }
      fs.writeFileSync(configPath, stringify(configJson, null, 2));
      console.log(
        "Successfully removed the mgrep tool from the OpenCode agent",
      );
    } else {
      console.log("The mgrep tool is not installed in the OpenCode agent");
    }
  } catch (error) {
    console.error(`Error uninstalling plugin: ${error}`);
    process.exit(1);
  }
}

export const installOpencode = new Command("install-opencode")
  .description("Install the mgrep tool in the OpenCode agent")
  .action(async () => {
    await ensureAuthenticated();
    await installPlugin();
  });

export const uninstallOpencode = new Command("uninstall-opencode")
  .description("Uninstall the mgrep tool from the OpenCode agent")
  .action(async () => {
    await uninstallPlugin();
  });
