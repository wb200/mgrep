import { outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";

export async function logoutAction() {
  outro(
    chalk.blue(
      "No cloud session is stored locally. Unset DEEPINFRA_API_KEY and DASHSCOPE_API_KEY to disable provider access.",
    ),
  );
}

export const logout = new Command("logout")
  .description("Show how to disable local provider access")
  .action(logoutAction);
