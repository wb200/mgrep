import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import type { Git } from "./git.js";

export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [
  "py",
  "pyi",
  "pyw",
  "pyx",
  "pxd",
  "pxi",
  "ipynb",
  "md",
  "mdx",
  "rst",
  "txt",
  "adoc",
  "asciidoc",
  "toml",
  "ini",
  "cfg",
  "conf",
  "yaml",
  "yml",
  "json",
  "jsonc",
  "json5",
  "hjson",
  "properties",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ps1",
  "psm1",
  "jinja",
  "jinja2",
  "j2",
  "tpl",
  "tmpl",
  "template",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "xsd",
  "xsl",
  "xslt",
  "sql",
  "gql",
  "graphql",
  "graphqls",
  "proto",
  "tf",
  "tfvars",
  "hcl",
  "cue",
  "cmake",
  "mk",
  "nix",
  "rego",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "vue",
  "svelte",
  "patch",
  "diff",
  "http",
  "rest",
  "po",
  "pot",
  "mermaid",
  "mmd",
  "puml",
  "plantuml",
  "log",
];

export const DEFAULT_ALLOWED_NAMES: readonly string[] = [
  "Dockerfile",
  "Containerfile",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Justfile",
  "justfile",
  "Procfile",
  "Pipfile",
  "Jenkinsfile",
  "Tiltfile",
  "Earthfile",
  "Vagrantfile",
  "Snakefile",
  "Brewfile",
  "README",
  "LICENSE",
  "NOTICE",
  "COPYING",
  "CHANGELOG",
  "config",
  "Config",
];

export const DEFAULT_ALLOWED_DOTFILES: readonly string[] = [
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".dockerignore",
  ".pre-commit-config.yaml",
  ".python-version",
  ".tool-versions",
  ".coveragerc",
  ".flake8",
  ".mypy.ini",
  ".pylintrc",
  ".ruff.toml",
  ".pyre_configuration",
  ".isort.cfg",
  ".bumpversion.cfg",
  ".yamllint",
  ".prettierrc",
  ".eslintrc",
  ".eslintignore",
];

/**
 * Default glob patterns to ignore during file indexing.
 * These are not useful for the local text-first LanceDB index.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "*.lock",
  "*.bin",
  "*.pyc",
  "*.safetensors",
  "*.sqlite",
  "*.pt",
];

function isSameOrDescendantPath(
  candidatePath: string,
  parentPath: string,
): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);

  if (resolvedCandidate === resolvedParent) {
    return true;
  }

  const parentWithSep = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`;

  return resolvedCandidate.startsWith(parentWithSep);
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, "").toLowerCase();
}

function normalizeUnique(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function normalizeDotfile(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function isHiddenSegment(part: string): boolean {
  return part.startsWith(".") && part !== "." && part !== "..";
}

/**
 * Configuration options for file system operations
 */
export interface FileSystemOptions {
  /**
   * Additional glob patterns to ignore after allowlist admission.
   */
  ignorePatterns?: string[];

  /**
   * Absolute path prefixes that are always excluded from indexing.
   */
  blockedPaths?: string[];

  /**
   * Allowed file extensions for text indexing.
   */
  allowedExtensions?: string[];

  /**
   * Allowed exact basenames for extensionless files.
   */
  allowedNames?: string[];

  /**
   * Allowed hidden basenames. Hidden directories remain blocked.
   */
  allowedDotfiles?: string[];
}

/**
 * Interface for file system operations
 */
export interface FileSystem {
  /**
   * Gets all files in a directory
   */
  getFiles(dirRoot: string): Generator<string>;

  /**
   * Checks if a file should be ignored
   */
  isIgnored(filePath: string, root: string): boolean;

  /**
   * Loads the mgrepignore file for a directory
   */
  loadMgrepignore(dirRoot: string): void;
}

/**
 * Node.js implementation of FileSystem with gitignore support
 */
export class NodeFileSystem implements FileSystem {
  private customIgnoreFilter: ReturnType<typeof ignore>;
  private ignoreCache = new Map<string, ReturnType<typeof ignore>>();
  private allowedExtensions: Set<string>;
  private allowedNames: Set<string>;
  private allowedDotfiles: Set<string>;
  private blockedPaths: string[];

  constructor(
    private git: Git,
    options: FileSystemOptions,
  ) {
    this.customIgnoreFilter = ignore();
    this.customIgnoreFilter.add(options.ignorePatterns ?? []);
    this.allowedExtensions = new Set(
      normalizeUnique(options.allowedExtensions ?? []).map(normalizeExtension),
    );
    this.allowedNames = new Set(normalizeUnique(options.allowedNames ?? []));
    this.allowedDotfiles = new Set(
      normalizeUnique(options.allowedDotfiles ?? []).map(normalizeDotfile),
    );
    this.blockedPaths = normalizeUnique(options.blockedPaths ?? []).map(
      (value) => path.resolve(value),
    );
  }

  private getRelativeParts(filePath: string, root: string): string[] {
    const relativePath = path.relative(root, filePath);
    if (!relativePath || relativePath === ".") {
      return [];
    }
    return relativePath.split(path.sep).filter(Boolean);
  }

  private hasHiddenParentDirectory(filePath: string, root: string): boolean {
    const parts = this.getRelativeParts(filePath, root);
    return parts.slice(0, -1).some(isHiddenSegment);
  }

  private isAllowedFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    if (isHiddenSegment(basename)) {
      return this.allowedDotfiles.has(basename);
    }

    if (this.allowedNames.has(basename)) {
      return true;
    }

    const extension = normalizeExtension(path.extname(basename));
    return extension !== "" && this.allowedExtensions.has(extension);
  }

  /**
   * Gets all files recursively from a directory
   */
  private *getAllFilesRecursive(dir: string, root: string): Generator<string> {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (this.isIgnored(fullPath, root)) {
          continue;
        }

        if (entry.isDirectory()) {
          yield* this.getAllFilesRecursive(fullPath, root);
        } else if (entry.isFile()) {
          yield fullPath;
        }
      }
    } catch (error) {
      // Log permission or other filesystem errors
      console.error(`Warning: Failed to read directory ${dir}:`, error);
    }
  }

  *getFiles(dirRoot: string): Generator<string> {
    // Preload root .mgrepignore to ensure it's cached
    this.getDirectoryIgnoreFilter(dirRoot);

    if (this.git.isGitRepository(dirRoot)) {
      yield* this.git.getGitFiles(dirRoot);
    } else {
      yield* this.getAllFilesRecursive(dirRoot, dirRoot);
    }
  }

  private getDirectoryIgnoreFilter(dir: string): ReturnType<typeof ignore> {
    if (this.ignoreCache.has(dir)) {
      return this.ignoreCache.get(dir) ?? ignore();
    }

    const ig = ignore();

    // Load .gitignore
    const gitignorePath = path.join(dir, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, "utf8"));
    }

    // Load .mgrepignore
    const mgrepignorePath = path.join(dir, ".mgrepignore");
    if (fs.existsSync(mgrepignorePath)) {
      ig.add(fs.readFileSync(mgrepignorePath, "utf8"));
    }

    this.ignoreCache.set(dir, ig);
    return ig;
  }

  private isIgnoredByPatterns(
    filePath: string,
    root: string,
    isDirectory: boolean,
  ): boolean {
    const relativeToRoot = path.relative(root, filePath);
    const normalizedRootPath = relativeToRoot.replace(/\\/g, "/");

    const pathToCheckRoot = isDirectory
      ? `${normalizedRootPath}/`
      : normalizedRootPath;
    if (this.customIgnoreFilter.ignores(pathToCheckRoot)) {
      return true;
    }

    let currentDir = isDirectory ? filePath : path.dirname(filePath);
    const absoluteRoot = path.resolve(root);

    while (true) {
      const relativeToCurrent = path.relative(currentDir, filePath);
      if (relativeToCurrent !== "") {
        const normalizedRelative = relativeToCurrent.replace(/\\/g, "/");
        const pathToCheck = isDirectory
          ? `${normalizedRelative}/`
          : normalizedRelative;

        const filter = this.getDirectoryIgnoreFilter(currentDir);
        const result = filter.test(pathToCheck);
        if (result.ignored) {
          return true;
        }
        if (result.unignored) {
          return false;
        }
      }

      if (path.resolve(currentDir) === absoluteRoot) {
        break;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }

    return false;
  }

  isIgnored(filePath: string, root: string): boolean {
    if (
      this.blockedPaths.some((blockedPath) =>
        isSameOrDescendantPath(filePath, blockedPath),
      )
    ) {
      return true;
    }

    if (this.hasHiddenParentDirectory(filePath, root)) {
      return true;
    }

    let isDirectory = false;
    try {
      const stat = fs.statSync(filePath);
      isDirectory = stat.isDirectory();
    } catch {
      isDirectory = false;
    }

    const basename = path.basename(filePath);
    if (isDirectory) {
      if (isHiddenSegment(basename)) {
        return true;
      }
      return this.isIgnoredByPatterns(filePath, root, true);
    }

    if (!this.isAllowedFile(filePath)) {
      return true;
    }

    return this.isIgnoredByPatterns(filePath, root, false);
  }

  loadMgrepignore(dirRoot: string): void {
    // Now handled by getDirectoryIgnoreFilter and caching
    this.getDirectoryIgnoreFilter(dirRoot);
  }
}
