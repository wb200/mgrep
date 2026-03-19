import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { ensureAuthenticated } from "../lib/utils.js";
import { printInstallWarning } from "../lib/warning.js";

const shell =
  process.env.SHELL ||
  (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");

const execAsync = promisify(exec);
const MARKETPLACE_SOURCE = "wb200/mgrep";
const MARKETPLACE_NAME = "wb200-mgrep";
const PLUGIN_NAME = `mgrep@${MARKETPLACE_NAME}`;

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as Error & {
      stderr?: string;
      stdout?: string;
    };

    return `${error.message}\n${execError.stderr || execError.stdout || ""}`;
  }

  return String(error);
}

function isAlreadyConfiguredError(error: unknown): boolean {
  const message = getCommandErrorMessage(error).toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("already configured") ||
    message.includes("already added")
  );
}

function isMarketplaceNotFoundError(error: unknown): boolean {
  const message = getCommandErrorMessage(error).toLowerCase();
  return message.includes("marketplace") && message.includes("not found");
}

async function runClaudeCommand(command: string): Promise<void> {
  await execAsync(command, {
    shell,
    env: process.env,
  });
}

async function installPlugin() {
  try {
    await runClaudeCommand(
      `claude plugin marketplace add ${MARKETPLACE_SOURCE}`,
    );
    console.log(
      `Successfully added the ${MARKETPLACE_SOURCE} plugin marketplace`,
    );
  } catch (error) {
    if (isAlreadyConfiguredError(error)) {
      console.log(
        `The ${MARKETPLACE_SOURCE} plugin marketplace is already configured`,
      );
    } else {
      console.error(`Error installing plugin: ${error}`);
      console.error(
        `Do you have claude-code version 2.0.36 or higher installed?`,
      );
    }
  }

  try {
    await runClaudeCommand(
      `claude plugin marketplace update ${MARKETPLACE_NAME}`,
    );
    console.log(
      `Successfully updated the ${MARKETPLACE_SOURCE} plugin marketplace`,
    );
  } catch (error) {
    console.error(`Error updating plugin marketplace: ${error}`);
    console.error(
      `Do you have claude-code version 2.0.36 or higher installed?`,
    );
  }

  try {
    await runClaudeCommand(`claude plugin install ${PLUGIN_NAME}`);
    console.log("Successfully installed the mgrep plugin");
  } catch (error) {
    console.error(`Error installing plugin: ${error}`);
    console.error(
      `Do you have claude-code version 2.0.36 or higher installed?`,
    );
    process.exit(1);
  }

  printInstallWarning("Claude Code", "mgrep uninstall-claude-code");
}

async function uninstallPlugin() {
  try {
    await runClaudeCommand(`claude plugin uninstall ${PLUGIN_NAME}`);
    console.log("Successfully uninstalled the mgrep plugin");
  } catch (error) {
    console.error(`Error uninstalling plugin: ${error}`);
    console.error(
      `Do you have claude-code version 2.0.36 or higher installed?`,
    );
  }

  try {
    await runClaudeCommand(
      `claude plugin marketplace remove ${MARKETPLACE_SOURCE}`,
    );
    console.log(
      `Successfully removed the ${MARKETPLACE_SOURCE} plugin marketplace`,
    );
  } catch (error) {
    if (isMarketplaceNotFoundError(error)) {
      console.log(
        `The ${MARKETPLACE_SOURCE} plugin marketplace was not configured locally`,
      );
      return;
    }

    console.error(`Error removing plugin from marketplace: ${error}`);
    console.error(
      `Do you have claude-code version 2.0.36 or higher installed?`,
    );
    process.exit(1);
  }
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(async () => {
    await ensureAuthenticated();
    await installPlugin();
  });

export const uninstallClaudeCode = new Command("uninstall-claude-code")
  .description("Uninstall the Claude Code plugin")
  .action(async () => {
    await uninstallPlugin();
  });
