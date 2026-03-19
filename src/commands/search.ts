import type { Command } from "commander";
import { Command as CommanderCommand, InvalidArgumentError } from "commander";
import {
  executeAnswer,
  executeSearch,
  executeSync,
  resolveScopedPath,
} from "../lib/agent-service.js";
import { createStore } from "../lib/context.js";
import { output } from "../lib/logger.js";
import type {
  AskResponse,
  ChunkType,
  FileMetadata,
  SearchResponse,
  Store,
} from "../lib/store.js";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers.js";
import {
  isAtOrAboveHomeDirectory,
  MaxFileCountExceededError,
} from "../lib/utils.js";

function extractSources(response: AskResponse): { [key: number]: ChunkType } {
  const sources: { [key: number]: ChunkType } = {};
  const answer = response.answer;

  // Match ALL cite tags and capture the i="..."
  const citeTags = answer.match(/<cite i="(\d+(?:-\d+)?)"/g) ?? [];

  for (const tag of citeTags) {
    // Extract the index or index range inside the tag.
    const index = tag.match(/i="(\d+(?:-\d+)?)"/)?.[1];
    if (!index) continue;

    // Case 1: Single index
    if (!index.includes("-")) {
      const idx = Number(index);
      if (!Number.isNaN(idx) && idx < response.sources.length) {
        sources[idx] = response.sources[idx];
      }
      continue;
    }

    // Case 2: Range "start-end"
    const [start, end] = index.split("-").map(Number);

    if (
      !Number.isNaN(start) &&
      !Number.isNaN(end) &&
      start >= 0 &&
      end >= start &&
      end < response.sources.length
    ) {
      for (let i = start; i <= end; i++) {
        sources[i] = response.sources[i];
      }
    }
  }

  return sources;
}

function formatAskResponse(response: AskResponse, show_content: boolean) {
  const sources = extractSources(response);
  const sourceEntries = Object.entries(sources).map(
    ([index, chunk]) => `${index}: ${formatChunk(chunk, show_content)}`,
  );
  return `${response.answer}\n\n${sourceEntries.join("\n")}`;
}

function formatSearchResponse(response: SearchResponse, show_content: boolean) {
  return response.data
    .map((chunk) => formatChunk(chunk, show_content))
    .join("\n");
}

function formatChunk(chunk: ChunkType, show_content: boolean) {
  const pwd = process.cwd();

  const path =
    (chunk.metadata as FileMetadata)?.path?.replace(pwd, "") ?? "Unknown path";
  const start_line = (chunk.generated_metadata?.start_line as number) + 1;
  const end_line =
    start_line + (chunk.generated_metadata?.num_lines as number) - 1;
  const line_range = `:${start_line}-${end_line}`;
  const content = show_content ? chunk.text : "";

  return `.${path}${line_range} (${(chunk.score * 100).toFixed(2)}% match)${content ? `\n${content}` : ""}`;
}

function parseBooleanEnv(
  envVar: string | undefined,
  defaultValue: boolean,
): boolean {
  if (envVar === undefined) return defaultValue;
  const lower = envVar.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "y";
}

/**
 * Syncs local files to the store with progress indication.
 * @returns true if the caller should return early (dry-run mode), false otherwise
 */
async function syncFiles(
  store: Store,
  root: string,
  options: {
    store: string;
    path?: string;
    dryRun: boolean;
    maxFileSize?: number;
    maxFileCount?: number;
  },
): Promise<boolean> {
  const scopedRoot = resolveScopedPath(root, options.path);
  const { spinner, onProgress } = createIndexingSpinner(scopedRoot);

  try {
    const { result } = await executeSync(store, root, {
      store: options.store,
      path: options.path,
      dryRun: options.dryRun,
      maxFileSize: options.maxFileSize,
      maxFileCount: options.maxFileCount,
      onProgress,
    });

    while (true) {
      const info = await store.getInfo(options.store);
      spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
      if (info.counts.pending === 0 && info.counts.in_progress === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    spinner.succeed("Indexing complete");

    if (options.dryRun) {
      output(
        formatDryRunSummary(result, {
          actionDescription: "would have indexed",
        }),
      );
      return true;
    }

    return false;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option(
    "-m, --max-count <max_count>",
    "The maximum number of results to return",
    process.env.MGREP_MAX_COUNT || "10",
  )
  .option(
    "-c, --content",
    "Show content of the results",
    parseBooleanEnv(process.env.MGREP_CONTENT, false),
  )
  .option(
    "-a, --answer",
    "Generate an answer to the question based on the results",
    parseBooleanEnv(process.env.MGREP_ANSWER, false),
  )
  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    parseBooleanEnv(process.env.MGREP_SYNC, false),
  )
  .option(
    "-d, --dry-run",
    "Dry run the search process (no actual file syncing)",
    parseBooleanEnv(process.env.MGREP_DRY_RUN, false),
  )
  .option(
    "--no-rerank",
    "Disable reranking of search results",
    parseBooleanEnv(process.env.MGREP_RERANK, true), // `true` here means that reranking is enabled by default
  )
  .option(
    "--max-file-size <bytes>",
    "Maximum file size in bytes to upload",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("Must be a positive integer.");
      }
      return parsed;
    },
  )
  .option(
    "--max-file-count <count>",
    "Maximum number of files to upload",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new InvalidArgumentError("Must be a positive integer.");
      }
      return parsed;
    },
  )
  .option(
    "--agentic",
    "Enable agentic search to automatically refine queries and perform multiple searches",
    parseBooleanEnv(
      process.env.MGREP_AGENTIC ?? process.env.MGREP_AGENT,
      false,
    ),
  )
  .argument("<pattern>", "The pattern to search for")
  .argument("[path]", "The path to search in")
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: {
      store: string;
      maxCount: string;
      content: boolean;
      answer: boolean;
      sync: boolean;
      dryRun: boolean;
      rerank: boolean;
      maxFileSize?: number;
      maxFileCount?: number;
      agentic: boolean;
    } = cmd.optsWithGlobals();
    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    const root = process.cwd();
    const scopedPath = resolveScopedPath(root, exec_path);

    if (options.sync && isAtOrAboveHomeDirectory(scopedPath)) {
      console.error(
        "Error: Cannot sync home directory or any parent directory.",
      );
      console.error(
        "Please run this command from within a specific project subdirectory.",
      );
      process.exitCode = 1;
      return;
    }

    try {
      const store = await createStore();

      if (options.sync) {
        const shouldReturn = await syncFiles(store, root, {
          store: options.store,
          path: exec_path,
          dryRun: options.dryRun,
          maxFileSize: options.maxFileSize,
          maxFileCount: options.maxFileCount,
        });
        if (shouldReturn) {
          return;
        }
      }

      let response: string;
      if (!options.answer) {
        const results = await executeSearch(store, root, {
          store: options.store,
          path: exec_path,
          query: pattern,
          maxCount: parseInt(options.maxCount, 10),
          rerank: options.rerank,
          agentic: options.agentic,
        });
        response = formatSearchResponse(results.response, options.content);
      } else {
        const results = await executeAnswer(store, root, {
          store: options.store,
          path: exec_path,
          query: pattern,
          maxCount: parseInt(options.maxCount, 10),
          rerank: options.rerank,
          agentic: options.agentic,
        });
        response = formatAskResponse(results.response, options.content);
      }

      output(response);
    } catch (error) {
      if (error instanceof MaxFileCountExceededError) {
        console.error(`${error.message}`);
        console.error(
          "   Increase the limit with --max-file-count or MGREP_MAX_FILE_COUNT environment variable.\n",
        );
      } else {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(`Failed to search: ${message}`);
      }
      process.exitCode = 1;
    }
  });
