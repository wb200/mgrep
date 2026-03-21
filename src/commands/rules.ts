import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { output } from "../lib/logger.js";

interface RulesOutput {
  root: string;
  configFiles: {
    localCandidates: string[];
    localPresent: string[];
    globalCandidates: string[];
    globalPresent: string[];
  };
  allow: {
    extensions: string[];
    names: string[];
    dotfiles: string[];
  };
  block: {
    ignorePatterns: string[];
    blockedPaths: string[];
  };
  builtInRules: string[];
}

function resolveInspectionRoot(target?: string): string {
  if (!target) {
    return process.cwd();
  }

  const resolved = path.resolve(process.cwd(), target);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }

  try {
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return resolved;
  }
}

function formatDisplayPath(value: string): string {
  const homeDir = os.homedir();
  if (value === homeDir) {
    return "~";
  }

  const homeWithSep = homeDir.endsWith(path.sep)
    ? homeDir
    : `${homeDir}${path.sep}`;
  if (value.startsWith(homeWithSep)) {
    return `~/${value.slice(homeWithSep.length)}`;
  }

  return value;
}

function formatList(title: string, values: readonly string[]): string[] {
  if (values.length === 0) {
    return [`${title}: none`];
  }

  return [`${title}:`, ...values.map((value) => `  - ${value}`)];
}

function buildRulesOutput(root: string): RulesOutput {
  const config = loadConfig(root);
  const localCandidates = [
    path.join(root, ".mgreprc.yaml"),
    path.join(root, ".mgreprc.yml"),
  ];
  const globalConfigDir = path.join(os.homedir(), ".config", "mgrep");
  const globalCandidates = [
    path.join(globalConfigDir, "config.yaml"),
    path.join(globalConfigDir, "config.yml"),
  ];

  return {
    root,
    configFiles: {
      localCandidates,
      localPresent: localCandidates.filter((candidate) =>
        fs.existsSync(candidate),
      ),
      globalCandidates,
      globalPresent: globalCandidates.filter((candidate) =>
        fs.existsSync(candidate),
      ),
    },
    allow: {
      extensions: config.allowedExtensions,
      names: config.allowedNames,
      dotfiles: config.allowedDotfiles,
    },
    block: {
      ignorePatterns: config.ignorePatterns,
      blockedPaths: config.blockedPaths,
    },
    builtInRules: [
      "Hidden directories are always excluded from indexing.",
      "Files must match the allowlist before ignore rules are considered.",
    ],
  };
}

export function rulesAction(
  target: string | undefined,
  options: { json?: boolean },
): void {
  const root = resolveInspectionRoot(target);
  const rules = buildRulesOutput(root);

  if (options.json) {
    output(JSON.stringify(rules, null, 2));
    return;
  }

  const lines = [
    `Indexing rules for ${formatDisplayPath(rules.root)}`,
    "",
    ...formatList(
      "Local config candidates",
      rules.configFiles.localCandidates.map(formatDisplayPath),
    ),
    ...formatList(
      "Local config present",
      rules.configFiles.localPresent.map(formatDisplayPath),
    ),
    ...formatList(
      "Global config candidates",
      rules.configFiles.globalCandidates.map(formatDisplayPath),
    ),
    ...formatList(
      "Global config present",
      rules.configFiles.globalPresent.map(formatDisplayPath),
    ),
    "",
    ...formatList("Allowed extensions", rules.allow.extensions),
    ...formatList("Allowed names", rules.allow.names),
    ...formatList("Allowed dotfiles", rules.allow.dotfiles),
    "",
    ...formatList("Ignore patterns", rules.block.ignorePatterns),
    ...formatList(
      "Blocked path prefixes",
      rules.block.blockedPaths.map(formatDisplayPath),
    ),
    "",
    ...formatList("Built-in rules", rules.builtInRules),
  ];

  output(lines.join("\n"));
}

export const rules = new Command("rules")
  .argument("[path]", "Optional directory to inspect", undefined)
  .option("--json", "Emit the effective indexing rules as JSON", false)
  .description("Show the effective allow/block indexing rules")
  .action(rulesAction);
