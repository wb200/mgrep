import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isText } from "istextorbinary";
import pLimit from "p-limit";
import xxhashWasm from "xxhash-wasm";
import { exceedsMaxFileSize, type MgrepConfig } from "./config.js";
import type { FileSystem } from "./file.js";
import { getDeepInfraApiKey } from "./model-studio.js";
import type { Store } from "./store.js";
import type { InitialSyncProgress, InitialSyncResult } from "./sync-helpers.js";

export const isTest = process.env.MGREP_IS_TEST === "1";

/** Error thrown when the file count to sync exceeds the configured limit */
export class MaxFileCountExceededError extends Error {
  constructor(filesToSync: number, maxFileCount: number) {
    super(
      `Files to sync (${filesToSync}) exceeds the maximum allowed (${maxFileCount}). No files were synced.`,
    );
    this.name = "MaxFileCountExceededError";
  }
}

function isSubpath(parent: string, child: string): boolean {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);

  const parentWithSep = parentPath.endsWith(path.sep)
    ? parentPath
    : parentPath + path.sep;

  return childPath.startsWith(parentWithSep);
}

/**
 * Checks if a path is at or above the home directory.
 * Returns true if the path is the home directory, a parent of it, or the root.
 *
 * @param targetPath - The path to check
 * @returns true if the path is at or above home directory, false if it's a subdirectory of home
 */
export function isAtOrAboveHomeDirectory(targetPath: string): boolean {
  const homeDir = os.homedir();
  const resolvedTarget = path.resolve(targetPath);
  const resolvedHome = path.resolve(homeDir);

  if (resolvedTarget === resolvedHome) {
    return true;
  }

  const targetWithSep = resolvedTarget.endsWith(path.sep)
    ? resolvedTarget
    : resolvedTarget + path.sep;

  if (resolvedHome.startsWith(targetWithSep)) {
    return true;
  }

  return false;
}

const XXHASH_PREFIX = "xxh64:";

/** Lazily initialized xxhash instance */
const xxhashPromise = xxhashWasm();

/**
 * Computes SHA-256 hash of a buffer (used for backward compatibility)
 */
function computeSha256Hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Computes xxhash64 hash of a buffer.
 * Returns the hash prefixed with "xxh64:" to identify the algorithm.
 */
export async function computeBufferHash(buffer: Buffer): Promise<string> {
  const { h64Raw } = await xxhashPromise;
  const hash = h64Raw(new Uint8Array(buffer)).toString(16).padStart(16, "0");
  return XXHASH_PREFIX + hash;
}

/**
 * Computes a hash of the file using xxhash64.
 */
export async function computeFileHash(
  filePath: string,
  readFileSyncFn: (p: string) => Buffer,
): Promise<string> {
  const buffer = readFileSyncFn(filePath);
  return computeBufferHash(buffer);
}

/**
 * Checks if a stored hash matches the computed hash of a buffer.
 * Supports both old SHA-256 hashes (no prefix) and new xxhash64 hashes (xxh64: prefix).
 */
export async function hashesMatch(
  storedHash: string,
  buffer: Buffer,
): Promise<boolean> {
  if (storedHash.startsWith(XXHASH_PREFIX)) {
    const computedHash = await computeBufferHash(buffer);
    return storedHash === computedHash;
  }
  const computedSha256 = computeSha256Hash(buffer);
  return storedHash === computedSha256;
}

export function isDevelopment(): boolean {
  if (process.env.NODE_ENV === "development" || isTest) {
    return true;
  }

  return false;
}

/** Metadata stored for each file in the store */
export interface StoredFileMetadata {
  hash?: string;
  mtime?: number;
}

/**
 * Lists file metadata from the store, optionally filtered by path prefix.
 *
 * @param store - The store instance
 * @param storeId - The ID of the store
 * @param pathPrefix - Optional path prefix to filter files (only files starting with this path are returned)
 * @returns A map of external IDs to their metadata (hash and mtime)
 */
export async function listStoreFileMetadata(
  store: Store,
  storeId: string,
  pathPrefix?: string,
): Promise<Map<string, StoredFileMetadata>> {
  const byExternalId = new Map<string, StoredFileMetadata>();
  for await (const file of store.listFiles(storeId, { pathPrefix })) {
    const externalId = file.external_id ?? undefined;
    if (!externalId) continue;
    const metadata = file.metadata;
    const hash: string | undefined =
      metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
    const mtime: number | undefined =
      metadata && typeof metadata.mtime === "number"
        ? metadata.mtime
        : undefined;
    byExternalId.set(externalId, { hash, mtime });
  }
  return byExternalId;
}

export async function ensureConfigured(): Promise<void> {
  if (!getDeepInfraApiKey()) {
    throw new Error(
      "DEEPINFRA_API_KEY is not set. Export a DeepInfra API key for embeddings, rerank, answers, and agentic planning before using mgrep.",
    );
  }
}

export const ensureAuthenticated = ensureConfigured;

export async function deleteFile(
  store: Store,
  storeId: string,
  filePath: string,
): Promise<void> {
  await store.deleteFile(storeId, filePath);
}

export async function uploadFile(
  store: Store,
  storeId: string,
  filePath: string,
  fileName: string,
  config?: MgrepConfig,
  preloaded?: { buffer: Buffer; stat: fs.Stats },
  deferIndexing = false,
): Promise<boolean> {
  // Use preloaded stat for size check to avoid a redundant statSync.
  if (config) {
    const fileSize = preloaded
      ? preloaded.stat.size
      : fs.statSync(filePath).size;
    if (fileSize > config.maxFileSize) {
      return false;
    }
  }

  // Reuse caller-supplied buffer+stat when available (avoids a second readFile).
  const [buffer, stat] = preloaded
    ? [preloaded.buffer, preloaded.stat]
    : await Promise.all([
        fs.promises.readFile(filePath),
        fs.promises.stat(filePath),
      ]);

  if (buffer.length === 0) {
    return false;
  }

  if (!isText(filePath, buffer)) {
    return false;
  }

  const hash = await computeBufferHash(buffer);
  const options = {
    external_id: filePath,
    overwrite: true,
    metadata: {
      path: filePath,
      hash,
      mtime: stat.mtimeMs,
    },
    deferIndexing,
  };

  await store.uploadFile(
    storeId,
    // Wrap in Uint8Array so TypeScript accepts it as BlobPart; File copies the
    // data regardless, so this is zero extra overhead in practice.
    new File([new Uint8Array(buffer)], fileName, { type: "text/plain" }),
    options,
  );
  return true;
}

export async function initialSync(
  store: Store,
  fileSystem: FileSystem,
  storeId: string,
  repoRoot: string,
  dryRun?: boolean,
  onProgress?: (info: InitialSyncProgress) => void,
  config?: MgrepConfig,
): Promise<InitialSyncResult> {
  const storeMetadata = await listStoreFileMetadata(store, storeId, repoRoot);
  const allFiles = Array.from(fileSystem.getFiles(repoRoot));
  const repoFiles = allFiles.filter(
    (filePath) => !fileSystem.isIgnored(filePath, repoRoot),
  );

  const repoFileSet = new Set(repoFiles);

  const filesToDelete = Array.from(storeMetadata.keys()).filter(
    (filePath) => isSubpath(repoRoot, filePath) && !repoFileSet.has(filePath),
  );

  // Check files that potentially need uploading (new or modified)
  const filesToPotentiallyUpload = repoFiles.filter((filePath) => {
    if (config && exceedsMaxFileSize(filePath, config.maxFileSize)) {
      return false;
    }
    const stored = storeMetadata.get(filePath);
    // If not in store, it needs uploading
    if (!stored) {
      return true;
    }
    // If no mtime stored, we need to check (conservative)
    if (!stored.mtime) {
      return true;
    }
    // Check mtime to see if file might have changed
    try {
      const stat = fs.statSync(filePath);
      return stat.mtimeMs > stored.mtime;
    } catch {
      return true;
    }
  });

  const filesToSync = filesToPotentiallyUpload.length + filesToDelete.length;
  if (config && filesToSync > config.maxFileCount) {
    throw new MaxFileCountExceededError(filesToSync, config.maxFileCount);
  }

  const total = repoFiles.length + filesToDelete.length;
  let processed = 0;
  let uploaded = 0;
  let deleted = 0;
  let errors = 0;

  const concurrency = config?.syncConcurrency ?? 5;
  const limit = pLimit(concurrency);

  // Process uploads in fixed-size batches so that completed promise closures
  // (and their captured buffers/vectors) are eligible for GC between batches,
  // rather than being held alive for the entire run by a single Promise.all.
  const UPLOAD_BATCH_SIZE = 50;
  for (let i = 0; i < repoFiles.length; i += UPLOAD_BATCH_SIZE) {
    const batch = repoFiles.slice(i, i + UPLOAD_BATCH_SIZE);
    await Promise.all(
      batch.map((filePath) =>
        limit(async () => {
          try {
            if (config && exceedsMaxFileSize(filePath, config.maxFileSize)) {
              processed += 1;
              onProgress?.({
                processed,
                uploaded,
                deleted,
                errors,
                total,
                filePath,
              });
              return;
            }

            const stored = storeMetadata.get(filePath);
            const stat = await fs.promises.stat(filePath);

            // Bloom filter: if mtime unchanged, file definitely unchanged
            if (stored?.mtime && stat.mtimeMs <= stored.mtime) {
              processed += 1;
              onProgress?.({
                processed,
                uploaded,
                deleted,
                errors,
                total,
                filePath,
              });
              return;
            }

            // mtime changed or no stored mtime - need to check hash
            const buffer = await fs.promises.readFile(filePath);
            processed += 1;
            const hashMatches = stored?.hash
              ? await hashesMatch(stored.hash, buffer)
              : false;
            const shouldUpload = !hashMatches;
            if (dryRun && shouldUpload) {
              console.log("Dry run: would have uploaded", filePath);
              uploaded += 1;
            } else if (shouldUpload) {
              // Pass the already-read buffer and stat to avoid a second readFile
              // inside uploadFile. Pass deferIndexing=true so FTS index rebuild
              // is skipped per-file; we rebuild once at the end of the full sync.
              const didUpload = await uploadFile(
                store,
                storeId,
                filePath,
                path.basename(filePath),
                config,
                { buffer, stat },
                true,
              );
              if (didUpload) {
                uploaded += 1;
              }
            }
            onProgress?.({
              processed,
              uploaded,
              deleted,
              errors,
              total,
              filePath,
            });
          } catch (err) {
            errors += 1;
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            onProgress?.({
              processed,
              uploaded,
              deleted,
              errors,
              total,
              filePath,
              lastError: errorMessage,
            });
          }
        }),
      ),
    );
  }

  await Promise.all(
    filesToDelete.map((filePath) =>
      limit(async () => {
        try {
          if (dryRun) {
            console.log("Dry run: would have deleted", filePath);
          } else {
            await store.deleteFile(storeId, filePath);
          }
          deleted += 1;
          processed += 1;
          onProgress?.({
            processed,
            uploaded,
            deleted,
            errors,
            total,
            filePath,
          });
        } catch (err) {
          processed += 1;
          errors += 1;
          const errorMessage = err instanceof Error ? err.message : String(err);
          onProgress?.({
            processed,
            uploaded,
            deleted,
            errors,
            total,
            filePath,
            lastError: errorMessage,
          });
        }
      }),
    ),
  );

  // Rebuild search indices once after all uploads and deletes are complete,
  // rather than after every individual file upload.
  if (!dryRun) {
    await store.ensureIndices(storeId);
  }

  return { processed, uploaded, deleted, errors, total };
}
