import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  DEFAULT_ALLOWED_DOTFILES,
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_ALLOWED_NAMES,
  DEFAULT_IGNORE_PATTERNS,
} from "./file.js";

const LOCAL_CONFIG_FILES = [".mgreprc.yaml", ".mgreprc.yml"] as const;
const GLOBAL_CONFIG_DIR = ".config/mgrep";
const GLOBAL_CONFIG_FILES = ["config.yaml", "config.yml"] as const;
const ENV_PREFIX = "MGREP_";
const DEFAULT_MAX_FILE_SIZE = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_COUNT = 10000;
const DEFAULT_LANCEDB_PATH = path.join(os.homedir(), ".mgrep", "lancedb");
const DEFAULT_SYNC_CONCURRENCY = 20;
const DEFAULT_EMBED_MODEL = "Qwen/Qwen3-Embedding-4B";
const DEFAULT_EMBED_DIMENSIONS = 2560;
const DEFAULT_RERANK_MODEL = "Qwen/Qwen3-Reranker-4B";
const DEFAULT_LLM_MODEL = "MiniMaxAI/MiniMax-M2.5";

const ConfigSchema = z.object({
  maxFileSize: z.number().positive().optional(),
  maxFileCount: z.number().positive().optional(),
  syncConcurrency: z.number().positive().optional(),
  lancedbPath: z.string().min(1).optional(),
  embedModel: z.string().min(1).optional(),
  embedDimensions: z.number().positive().optional(),
  rerankModel: z.string().min(1).optional(),
  llmModel: z.string().min(1).optional(),
  allowedExtensions: z.array(z.string().min(1)).optional(),
  allowedNames: z.array(z.string().min(1)).optional(),
  allowedDotfiles: z.array(z.string().min(1)).optional(),
  ignorePatterns: z.array(z.string().min(1)).optional(),
  blockedPaths: z.array(z.string().min(1)).optional(),
});

/**
 * CLI options that can override config
 */
export interface CliConfigOptions {
  maxFileSize?: number;
  maxFileCount?: number;
}

/**
 * Mgrep configuration options
 */
export interface MgrepConfig {
  /**
   * Maximum file size in bytes that is allowed to upload.
   * Files larger than this will be skipped during sync.
   * @default 4194304 (4 MiB)
   */
  maxFileSize: number;

  /**
   * Maximum number of files that can be synced (uploaded or deleted) in a single operation.
   * If more files need to be synced than this limit, an error will be thrown.
   * @default 10000
   */
  maxFileCount: number;

  /**
   * Base path for local LanceDB stores.
   */
  lancedbPath: string;

  /**
   * Maximum concurrency for sync operations.
   * @default 20
   */
  syncConcurrency: number;

  /**
   * The embedding model to use with DeepInfra.
   */
  embedModel: string;

  /**
   * Embedding vector dimensions.
   */
  embedDimensions: number;

  /**
   * The rerank model to use with DeepInfra.
   */
  rerankModel: string;

  /**
   * The DeepInfra LLM model to use for synthesized answers and agentic planning.
   */
  llmModel: string;

  /**
   * Allowed file extensions for text indexing.
   */
  allowedExtensions: string[];

  /**
   * Allowed exact basenames for extensionless files.
   */
  allowedNames: string[];

  /**
   * Allowed hidden basenames. Hidden directories remain blocked.
   */
  allowedDotfiles: string[];

  /**
   * Additional glob patterns that denylist files after allowlist admission.
   */
  ignorePatterns: string[];

  /**
   * Absolute path prefixes that are always excluded from indexing.
   */
  blockedPaths: string[];
}

const DEFAULT_BLOCKED_PATHS: readonly string[] = [];

const DEFAULT_CONFIG: MgrepConfig = {
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  maxFileCount: DEFAULT_MAX_FILE_COUNT,
  syncConcurrency: DEFAULT_SYNC_CONCURRENCY,
  lancedbPath: DEFAULT_LANCEDB_PATH,
  embedModel: DEFAULT_EMBED_MODEL,
  embedDimensions: DEFAULT_EMBED_DIMENSIONS,
  rerankModel: DEFAULT_RERANK_MODEL,
  llmModel: DEFAULT_LLM_MODEL,
  allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
  allowedNames: [...DEFAULT_ALLOWED_NAMES],
  allowedDotfiles: [...DEFAULT_ALLOWED_DOTFILES],
  ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
  blockedPaths: [...DEFAULT_BLOCKED_PATHS],
};

const configCache = new Map<string, MgrepConfig>();

/**
 * Reads and parses a YAML config file
 *
 * @param filePath - The path to the config file
 * @returns The parsed config object or null if file doesn't exist or is invalid
 */
function resolveConfigPath(value: string, baseDir: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed === "~") {
    return os.homedir();
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return path.resolve(baseDir, trimmed);
}

function normalizePathList(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => path.resolve(value.trim())).filter(Boolean)),
  );
}

function readYamlConfig(filePath: string): Partial<MgrepConfig> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(content);
    const validated = ConfigSchema.parse(parsed);
    return {
      ...validated,
      blockedPaths: validated.blockedPaths?.map((value) =>
        resolveConfigPath(value, path.dirname(filePath)),
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Warning: Failed to parse config file ${filePath}: ${message}`,
    );
    return null;
  }
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function normalizeDotfile(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeUnique(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function normalizeConfig(config: MgrepConfig): MgrepConfig {
  return {
    ...config,
    allowedExtensions: normalizeUnique(config.allowedExtensions).map(
      normalizeExtension,
    ),
    allowedNames: normalizeUnique(config.allowedNames),
    allowedDotfiles: normalizeUnique(config.allowedDotfiles).map(
      normalizeDotfile,
    ),
    ignorePatterns: normalizeUnique(config.ignorePatterns),
    blockedPaths: normalizePathList(config.blockedPaths),
  };
}

/**
 * Finds and reads the first existing config file from a list of candidates
 *
 * @param candidates - List of file paths to check
 * @returns The parsed config or null if none found
 */
function findConfig(candidates: string[]): Partial<MgrepConfig> | null {
  for (const filePath of candidates) {
    const config = readYamlConfig(filePath);
    if (config !== null) {
      return config;
    }
  }
  return null;
}

function getGlobalConfigPaths(): string[] {
  const configDir = path.join(os.homedir(), GLOBAL_CONFIG_DIR);
  return GLOBAL_CONFIG_FILES.map((file) => path.join(configDir, file));
}

function getLocalConfigPaths(dir: string): string[] {
  return LOCAL_CONFIG_FILES.map((file) => path.join(dir, file));
}

/**
 * Loads configuration from environment variables
 *
 * @returns The config values from environment variables
 */
function loadEnvConfig(): Partial<MgrepConfig> {
  const config: Partial<MgrepConfig> = {};

  const maxFileSizeEnv = process.env[`${ENV_PREFIX}MAX_FILE_SIZE`];
  if (maxFileSizeEnv) {
    const parsed = Number.parseInt(maxFileSizeEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.maxFileSize = parsed;
    }
  }

  const maxFileCountEnv = process.env[`${ENV_PREFIX}MAX_FILE_COUNT`];
  if (maxFileCountEnv) {
    const parsed = Number.parseInt(maxFileCountEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.maxFileCount = parsed;
    }
  }

  const syncConcurrencyEnv = process.env[`${ENV_PREFIX}SYNC_CONCURRENCY`];
  if (syncConcurrencyEnv) {
    const parsed = Number.parseInt(syncConcurrencyEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.syncConcurrency = parsed;
    }
  }

  const lancedbPathEnv = process.env[`${ENV_PREFIX}LANCEDB_PATH`];
  if (lancedbPathEnv) {
    config.lancedbPath = lancedbPathEnv;
  }

  const embedModelEnv = process.env[`${ENV_PREFIX}EMBED_MODEL`];
  if (embedModelEnv) {
    config.embedModel = embedModelEnv;
  }

  const embedDimensionsEnv = process.env[`${ENV_PREFIX}EMBED_DIMENSIONS`];
  if (embedDimensionsEnv) {
    const parsed = Number.parseInt(embedDimensionsEnv, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.embedDimensions = parsed;
    }
  }

  const rerankModelEnv = process.env[`${ENV_PREFIX}RERANK_MODEL`];
  if (rerankModelEnv) {
    config.rerankModel = rerankModelEnv;
  }

  const llmModelEnv = process.env[`${ENV_PREFIX}LLM_MODEL`];
  if (llmModelEnv) {
    config.llmModel = llmModelEnv;
  }

  return config;
}

/**
 * Loads mgrep configuration with the following precedence (highest to lowest):
 * 1. CLI flags (passed as cliOptions)
 * 2. Environment variables (MGREP_MAX_FILE_SIZE, MGREP_MAX_FILE_COUNT)
 * 3. Local config file (.mgreprc.yaml or .mgreprc.yml in project directory)
 * 4. Global config file (~/.config/mgrep/config.yaml or config.yml)
 * 5. Default values
 *
 * @param dir - The directory to load local configuration from
 * @param cliOptions - CLI options that override all other config sources
 * @returns The merged configuration
 */
export function loadConfig(
  dir: string,
  cliOptions: CliConfigOptions = {},
): MgrepConfig {
  const absoluteDir = path.resolve(dir);
  const cacheKey = `${absoluteDir}:${JSON.stringify(cliOptions)}`;

  if (configCache.has(cacheKey)) {
    return configCache.get(cacheKey) as MgrepConfig;
  }

  const globalConfig = findConfig(getGlobalConfigPaths());
  const localConfig = findConfig(getLocalConfigPaths(absoluteDir));
  const envConfig = loadEnvConfig();

  const config: MgrepConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...localConfig,
    ...envConfig,
    ...filterUndefinedCliOptions(cliOptions),
    ignorePatterns: [
      ...DEFAULT_IGNORE_PATTERNS,
      ...(globalConfig?.ignorePatterns ?? []),
      ...(localConfig?.ignorePatterns ?? []),
    ],
    blockedPaths: [
      ...DEFAULT_BLOCKED_PATHS,
      ...(globalConfig?.blockedPaths ?? []),
      ...(localConfig?.blockedPaths ?? []),
    ],
  };

  const normalizedConfig = normalizeConfig(config);
  configCache.set(cacheKey, normalizedConfig);
  return normalizedConfig;
}

function filterUndefinedCliOptions(
  options: CliConfigOptions,
): Partial<MgrepConfig> {
  const result: Partial<MgrepConfig> = {};
  if (options.maxFileSize !== undefined) {
    result.maxFileSize = options.maxFileSize;
  }
  if (options.maxFileCount !== undefined) {
    result.maxFileCount = options.maxFileCount;
  }
  return result;
}

/**
 * Clears the configuration cache.
 * Useful for testing or when config files may have changed.
 */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Checks if a file exceeds the maximum allowed file size
 *
 * @param filePath - The path to the file to check
 * @param maxFileSize - The maximum allowed file size in bytes
 * @returns True if the file exceeds the limit, false otherwise
 */
export function exceedsMaxFileSize(
  filePath: string,
  maxFileSize: number,
): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.size > maxFileSize;
  } catch {
    return false;
  }
}

/**
 * Formats a file size in bytes to a human-readable string
 *
 * @param bytes - The file size in bytes
 * @returns Human-readable file size string
 */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}
