import * as fs from "node:fs";
import * as path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { type CliConfigOptions, loadConfig } from "../lib/config.js";
import { createFileSystem, createStore } from "../lib/context.js";
import { output } from "../lib/logger.js";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers.js";
import {
  deleteFile,
  initialSync,
  isAtOrAboveHomeDirectory,
  MaxFileCountExceededError,
  uploadFile,
} from "../lib/utils.js";

export interface WatchOptions {
  store: string;
  dryRun: boolean;
  maxFileSize?: number;
  maxFileCount?: number;
}

type WatchFactory = typeof fs.watch;

let watchFactory: WatchFactory = fs.watch;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
let pollingIntervalMs = DEFAULT_POLL_INTERVAL_MS;

function formatPollingInterval(intervalMs: number): string {
  if (intervalMs % 1000 === 0) {
    return `${intervalMs / 1000}s`;
  }
  return `${intervalMs}ms`;
}

function isEnospcError(
  error: unknown,
): error is Error & { code: "ENOSPC" | string } {
  return error instanceof Error && "code" in error && error.code === "ENOSPC";
}

function reportWatchError(error: unknown, watchRoot: string): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Watcher failed:", message);

  if (isEnospcError(error)) {
    console.error(
      `The OS file watcher limit was reached while watching ${watchRoot}.`,
    );
  }

  console.error(
    "Try watching a narrower directory, add excludes via .mgrepignore or blockedPaths, or raise fs.inotify.max_user_watches/fs.inotify.max_user_instances.",
  );
}

function reportPollingFailure(error: unknown): void {
  if (error instanceof MaxFileCountExceededError) {
    console.error(`\n❌ ${error.message}`);
    console.error(
      "   Increase the limit with --max-file-count or MGREP_MAX_FILE_COUNT environment variable.\n",
    );
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error("Polling sync failed:", message);
}

function startPollingFallback(
  store: Awaited<ReturnType<typeof createStore>>,
  fileSystem: ReturnType<typeof createFileSystem>,
  options: WatchOptions,
  watchRoot: string,
  config: ReturnType<typeof loadConfig>,
): void {
  console.error(
    `Falling back to polling every ${formatPollingInterval(pollingIntervalMs)}.`,
  );
  console.log("Polling for file changes in", watchRoot);

  let pollingInProgress = false;
  const runPollingSync = async () => {
    if (pollingInProgress) {
      return;
    }

    pollingInProgress = true;
    try {
      const result = await initialSync(
        store,
        fileSystem,
        options.store,
        watchRoot,
        false,
        undefined,
        config,
      );
      if (result.uploaded > 0 || result.deleted > 0 || result.errors > 0) {
        const deletedInfo =
          result.deleted > 0 ? ` • deleted ${result.deleted}` : "";
        const errorsInfo = result.errors > 0 ? ` • errors ${result.errors}` : "";
        console.log(
          `Polling sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}${deletedInfo}${errorsInfo}`,
        );
      }
    } catch (error) {
      reportPollingFailure(error);
    } finally {
      pollingInProgress = false;
    }
  };

  void runPollingSync();
  setInterval(() => {
    void runPollingSync();
  }, pollingIntervalMs);
}

export function setWatchFactoryForTesting(factory?: WatchFactory): void {
  watchFactory = factory ?? fs.watch;
}

export function setPollingIntervalMsForTesting(intervalMs?: number): void {
  pollingIntervalMs = intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
}

export async function startWatch(options: WatchOptions): Promise<void> {
  try {
    const watchRoot = process.cwd();

    if (isAtOrAboveHomeDirectory(watchRoot)) {
      console.error(
        "Error: Cannot watch home directory or any parent directory.",
      );
      console.error(
        "Please run this command from within a specific project subdirectory.",
      );
      process.exitCode = 1;
      return;
    }

    const store = await createStore();
    const cliOptions: CliConfigOptions = {
      maxFileSize: options.maxFileSize,
      maxFileCount: options.maxFileCount,
    };
    const config = loadConfig(watchRoot, cliOptions);
    const fileSystem = createFileSystem({
      ignorePatterns: config.ignorePatterns,
      blockedPaths: config.blockedPaths,
      allowedExtensions: config.allowedExtensions,
      allowedNames: config.allowedNames,
      allowedDotfiles: config.allowedDotfiles,
    });
    console.debug("Watching for file changes in", watchRoot);

    const { spinner, onProgress } = createIndexingSpinner(watchRoot);
    try {
      try {
        await store.retrieve(options.store);
      } catch {
        await store.create({
          name: options.store,
          description: "mgrep local LanceDB store",
        });
      }
      const result = await initialSync(
        store,
        fileSystem,
        options.store,
        watchRoot,
        options.dryRun,
        onProgress,
        config,
      );
      const deletedInfo =
        result.deleted > 0 ? ` • deleted ${result.deleted}` : "";
      const errorsInfo = result.errors > 0 ? ` • errors ${result.errors}` : "";
      if (result.errors > 0) {
        spinner.warn(
          `Initial sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}${deletedInfo}${errorsInfo}`,
        );
        console.error(
          `\n⚠️  ${result.errors} file(s) failed to upload. Run with DEBUG=mgrep* for more details.`,
        );
      } else {
        spinner.succeed(
          `Initial sync complete (${result.processed}/${result.total}) • uploaded ${result.uploaded}${deletedInfo}`,
        );
      }
      if (options.dryRun) {
        output(
          formatDryRunSummary(result, {
            actionDescription: "found",
            includeTotal: true,
          }),
        );
        return;
      }
    } catch (e) {
      if (e instanceof MaxFileCountExceededError) {
        spinner.fail("File count exceeded");
        console.error(`\n❌ ${e.message}`);
        console.error(
          "   Increase the limit with --max-file-count or MGREP_MAX_FILE_COUNT environment variable.\n",
        );
        process.exit(1);
      }
      spinner.fail("Initial upload failed");
      throw e;
    }

    console.log("Watching for file changes in", watchRoot);
    fileSystem.loadMgrepignore(watchRoot);
    let watcherFailed = false;
    const handleWatcherFailure = (error: unknown) => {
      if (watcherFailed) {
        return;
      }
      watcherFailed = true;
      reportWatchError(error, watchRoot);
      if (isEnospcError(error)) {
        startPollingFallback(store, fileSystem, options, watchRoot, config);
        return;
      }
      process.exitCode = 1;
    };

    let watcher: fs.FSWatcher;
    try {
      watcher = watchFactory(
        watchRoot,
        { recursive: true },
        (eventType, rawFilename) => {
          const filename = rawFilename?.toString();
          if (!filename) {
            return;
          }
          const filePath = path.join(watchRoot, filename);

          if (fileSystem.isIgnored(filePath, watchRoot)) {
            return;
          }

          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
              return;
            }

            uploadFile(store, options.store, filePath, filename, config)
              .then((didUpload) => {
                if (didUpload) {
                  console.log(`${eventType}: ${filePath}`);
                }
              })
              .catch((err) => {
                console.error("Failed to upload changed file:", filePath, err);
              });
          } catch {
            if (filePath.startsWith(watchRoot) && !fs.existsSync(filePath)) {
              deleteFile(store, options.store, filePath)
                .then(() => {
                  console.log(`delete: ${filePath}`);
                })
                .catch((err) => {
                  console.error("Failed to delete file:", filePath, err);
                });
            }
          }
        },
      );
    } catch (error) {
      handleWatcherFailure(error);
      return;
    }

    watcher.on("error", (error) => {
      handleWatcherFailure(error);
      try {
        watcher.close();
      } catch {
        // Ignore close errors after the watcher has already failed.
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to start watcher:", message);
    process.exitCode = 1;
  }
}

export const watch = new Command("watch")
  .option(
    "-d, --dry-run",
    "Dry run the watch process (no actual file syncing)",
    false,
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
  .description("Watch for file changes")
  .action(async (_args, cmd) => {
    const options: WatchOptions = cmd.optsWithGlobals();
    await startWatch(options);
  });
