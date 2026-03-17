import { intro, outro } from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import {
  createModelStudioConfig,
  ModelStudioClient,
} from "../lib/model-studio.js";

export async function loginAction() {
  intro(chalk.bold("🔐 Provider Configuration Check"));

  try {
    const config = loadConfig(process.cwd());
    const client = new ModelStudioClient(
      createModelStudioConfig({
        embedModel: config.embedModel,
        embedDimensions: config.embedDimensions,
        rerankModel: config.rerankModel,
        llmModel: config.llmModel,
      }),
    );

    await client.validate();

    outro(
      chalk.green(
        `Configuration looks valid. Embeddings=${config.embedModel} (${config.embedDimensions} dims), rerank=${config.rerankModel}, responses=${config.llmModel}.`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

export const login = new Command("login")
  .description(
    "Validate the DeepInfra and Alibaba Cloud provider configuration",
  )
  .action(loginAction);
