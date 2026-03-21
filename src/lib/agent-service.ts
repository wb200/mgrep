import { join, normalize } from "node:path";
import {
  type CliConfigOptions,
  loadConfig,
  type MgrepConfig,
} from "./config.js";
import { createFileSystem } from "./context.js";
import type {
  AskResponse,
  ChunkType,
  SearchFilter,
  SearchOptions,
  SearchResponse,
  Store,
} from "./store.js";
import type { InitialSyncProgress, InitialSyncResult } from "./sync-helpers.js";
import { initialSync, isAtOrAboveHomeDirectory } from "./utils.js";

const STORE_DESCRIPTION = "mgrep local LanceDB store";

export interface SearchHit {
  path: string;
  hash: string;
  mtime?: number;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  chunkIndex: number;
}

export interface QueryExecutionOptions {
  store: string;
  query: string;
  maxCount: number;
  path?: string;
  rerank: boolean;
  agentic: boolean;
}

export interface SyncExecutionOptions extends CliConfigOptions {
  store: string;
  path?: string;
  dryRun: boolean;
  onProgress?: (info: InitialSyncProgress) => void;
}

export interface SyncExecutionResult {
  root: string;
  config: MgrepConfig;
  result: InitialSyncResult;
}

export function resolveScopedPath(root: string, execPath?: string): string {
  if (!execPath) {
    return normalize(root);
  }

  return execPath.startsWith("/")
    ? normalize(execPath)
    : normalize(join(root, execPath));
}

export function buildPathFilter(searchPath: string): SearchFilter {
  return {
    all: [
      {
        key: "path",
        operator: "starts_with",
        value: searchPath,
      },
    ],
  };
}

export function createSearchOptions(
  rerank: boolean,
  agentic: boolean,
): SearchOptions {
  return {
    rerank,
    ...(agentic && { agentic: true }),
  };
}

export function chunkToSearchHit(chunk: ChunkType): SearchHit {
  const startLine = chunk.generated_metadata.start_line + 1;
  const endLine = startLine + chunk.generated_metadata.num_lines - 1;

  return {
    path: chunk.metadata.path,
    hash: chunk.metadata.hash,
    mtime: chunk.metadata.mtime,
    startLine,
    endLine,
    score: chunk.score,
    text: chunk.text,
    chunkIndex: chunk.chunk_index,
  };
}

export function loadProjectConfig(
  root: string,
  cliOptions: CliConfigOptions = {},
): MgrepConfig {
  return loadConfig(root, cliOptions);
}

export async function ensureStoreExists(
  store: Store,
  storeName: string,
): Promise<void> {
  try {
    await store.retrieve(storeName);
  } catch {
    await store.create({
      name: storeName,
      description: STORE_DESCRIPTION,
    });
  }
}

export function assertSyncPathAllowed(targetPath: string): void {
  if (isAtOrAboveHomeDirectory(targetPath)) {
    throw new Error(
      "Cannot sync the home directory or any parent directory. Run mgrep from within a specific project subdirectory.",
    );
  }
}

export async function executeSearch(
  store: Store,
  root: string,
  options: QueryExecutionOptions,
): Promise<{ scopedPath: string; response: SearchResponse }> {
  const scopedPath = resolveScopedPath(root, options.path);
  const response = await store.search(
    [options.store],
    options.query,
    options.maxCount,
    createSearchOptions(options.rerank, options.agentic),
    buildPathFilter(scopedPath),
  );

  return { scopedPath, response };
}

export async function executeAnswer(
  store: Store,
  root: string,
  options: QueryExecutionOptions,
): Promise<{ scopedPath: string; response: AskResponse }> {
  const scopedPath = resolveScopedPath(root, options.path);
  const response = await store.ask(
    [options.store],
    options.query,
    options.maxCount,
    createSearchOptions(options.rerank, options.agentic),
    buildPathFilter(scopedPath),
  );

  return { scopedPath, response };
}

export async function executeSync(
  store: Store,
  root: string,
  options: SyncExecutionOptions,
): Promise<SyncExecutionResult> {
  const scopedPath = resolveScopedPath(root, options.path);
  assertSyncPathAllowed(scopedPath);
  await ensureStoreExists(store, options.store);

  const config = loadProjectConfig(scopedPath, {
    maxFileSize: options.maxFileSize,
    maxFileCount: options.maxFileCount,
  });
  const fileSystem = createFileSystem({
    ignorePatterns: config.ignorePatterns,
    blockedPaths: config.blockedPaths,
    allowedExtensions: config.allowedExtensions,
    allowedNames: config.allowedNames,
    allowedDotfiles: config.allowedDotfiles,
  });
  const result = await initialSync(
    store,
    fileSystem,
    options.store,
    scopedPath,
    options.dryRun,
    options.onProgress,
    config,
  );

  return {
    root: scopedPath,
    config,
    result,
  };
}
