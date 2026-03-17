import { loadConfig } from "./config.js";
import {
  type FileSystem,
  type FileSystemOptions,
  NodeFileSystem,
} from "./file.js";
import { type Git, NodeGit } from "./git.js";
import { createModelStudioConfig, ModelStudioClient } from "./model-studio.js";
import { LanceStore, type Store, TestStore } from "./store.js";
import { isTest } from "./utils.js";

/**
 * Creates a configured Store instance.
 */
export async function createStore(): Promise<Store> {
  if (isTest) {
    return new TestStore();
  }

  const config = loadConfig(process.cwd());
  const client = new ModelStudioClient(
    createModelStudioConfig({
      embedModel: config.embedModel,
      embedDimensions: config.embedDimensions,
      rerankModel: config.rerankModel,
      llmModel: config.llmModel,
    }),
  );

  return new LanceStore(config, client);
}

/**
 * Creates a Git instance
 */
export function createGit(): Git {
  return new NodeGit();
}

/**
 * Creates a FileSystem instance
 */
export function createFileSystem(
  options: FileSystemOptions = { ignorePatterns: [] },
): FileSystem {
  return new NodeFileSystem(createGit(), options);
}
