<div align="center">
  <h1>mgrep</h1>
  <p><em>Semantic code search powered by local LanceDB embeddings — feels as immediate as <code>grep</code>.</em></p>
  <a href="https://www.npmjs.com/package/@wb200/mgrep"><img src="https://badge.fury.io/js/%40wb200%2Fmgrep.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
</div>

## Why mgrep?

- Natural-language search that feels as immediate as `grep`.
- Semantic search over your local codebase — no cloud upload of source code required.
- Smooth background indexing via `mgrep watch`, designed to detect and keep up-to-date everything that matters inside any git repository.
- First-class coding agent integrations (Claude Code, Codex, OpenCode, Factory Droid).
- Built for agents and humans alike: quiet output, thoughtful defaults, and escape hatches everywhere.

```bash
# index once
mgrep watch

# then ask your repo things in natural language
mgrep "where do we set up auth?"
```

## Quick Start

1. **Install**
   ```bash
   npm install -g @wb200/mgrep    # or pnpm / bun
   ```

2. **Set API keys**
   ```bash
   export DEEPINFRA_API_KEY=your_deepinfra_key     # for embeddings & rerank
   export DASHSCOPE_API_KEY=your_dashscope_key     # for synthesized answers
   ```
   - **DeepInfra**: Sign up at [deepinfra.com](https://deepinfra.com) — used for Qwen3 embeddings and reranking.
   - **Alibaba Cloud DashScope (Singapore)**: Sign up at [dashscope.aliyuncs.com](https://dashscope-intl.aliyuncs.com) — used for the Responses API (answers and agentic planning). Only required if you use `--answer` or `--agentic`.

3. **Validate your configuration**
   ```bash
   mgrep validate
   ```

4. **Index a project**
   ```bash
   cd path/to/repo
   mgrep watch
   ```
   `watch` performs an initial sync, respects `.gitignore`, then keeps the local LanceDB store updated as files change.

5. **Search anything**
   ```bash
   mgrep "where do we set up auth?" src/lib
   mgrep -m 25 "store schema"
   ```
   Searches default to the current working directory unless you pass a path.

## Using it with Coding Agents

> [!NOTE]
> **Default Limits**: mgrep enforces default limits to ensure optimal performance:
> - **Maximum file size**: 4MB per file
> - **Maximum file count**: 10,000 files per directory
>
> These limits can be customized via CLI flags (`--max-file-size`, `--max-file-count`),
> environment variables, or config files. See the [Configuration](#configuration) section for details.

`mgrep` supports assisted installation commands for many agents:
- `mgrep install-claude-code` for Claude Code
- `mgrep install-opencode` for OpenCode
- `mgrep install-codex` for Codex
- `mgrep install-droid` for Factory Droid

## When to use what

`mgrep` complements `grep`, not replaces it. The best code search combines both.

| Use `grep` (or `ripgrep`) for... | Use `mgrep` for... |
| --- | --- |
| **Exact Matches** | **Intent Search** |
| Symbol tracing, Refactoring, Regex | Code exploration, Feature discovery, Onboarding |

## mgrep as Subagent

For complex questions that require information from multiple sources, `mgrep` can act as a subagent that automatically refines queries and performs multiple searches.

```bash
# Enable agentic search for complex multi-part questions
mgrep --agentic "What are the yearly numbers for 2020, 2021, 2022, 2023, 2024?"

# Combine with --answer for a synthesized response from multiple sources
mgrep --agentic -a "How does authentication work and where is it configured?"
```

When `--agentic` is enabled, mgrep will:
- Automatically break down complex queries into sub-queries
- Perform multiple searches to gather comprehensive results
- Combine findings from different parts of your codebase

## Commands at a Glance

| Command | Purpose |
| --- | --- |
| `mgrep` / `mgrep search <pattern> [path]` | Natural-language search with many `grep`-style flags (`-i`, `-r`, `-m`...). |
| `mgrep watch` | Index current repo and keep the local store in sync via file watchers. |
| `mgrep validate` | Validate DeepInfra and Alibaba Cloud API key configuration. |
| `mgrep install-claude-code` | Add the mgrep MCP plugin to Claude Code. |
| `mgrep install-opencode` | Add mgrep to OpenCode. |
| `mgrep install-codex` | Add mgrep to Codex. |
| `mgrep install-droid` | Add mgrep hooks/skills to Factory Droid. |

### mgrep search

`mgrep search` is the default command. It searches the current directory for a pattern.

| Option | Description |
| --- | --- |
| `-m <max_count>` | The maximum number of results to return |
| `-c`, `--content` | Show content of the results |
| `-a`, `--answer` | Generate an answer to the question based on the results |
| `--agentic` | Enable agentic search to automatically refine queries and perform multiple searches |
| `-s`, `--sync` | Sync the local files to the store before searching |
| `-d`, `--dry-run` | Dry run the search process (no actual file syncing) |
| `--no-rerank` | Disable reranking of search results |
| `--max-file-size <bytes>` | Maximum file size in bytes to upload (overrides config) |
| `--max-file-count <count>` | Maximum number of files to upload (overrides config) |

All search options can also be configured via environment variables (see [Environment Variables](#environment-variables) section below).

**Examples:**
```bash
mgrep "What code parsers are available?"          # search in the current directory
mgrep "How are chunks defined?" src/models        # search in the src/models directory
mgrep -m 10 "maximum concurrent workers"          # limit results to 10
mgrep -a "What code parsers are available?"       # generate an answer based on results
mgrep --agentic -a "How does the sync pipeline work?"   # agentic multi-query answer
```

### mgrep watch

`mgrep watch` indexes the current repository and keeps the local LanceDB store in sync via file watchers.

It respects the current `.gitignore`, as well as a `.mgrepignore` file in the root of the repository. The `.mgrepignore` file follows the same syntax as the [`.gitignore`](https://git-scm.com/docs/gitignore) file.

| Option | Description |
| --- | --- |
| `-d`, `--dry-run` | Dry run the watch process (no actual file syncing) |
| `--max-file-size <bytes>` | Maximum file size in bytes to upload (overrides config) |
| `--max-file-count <count>` | Maximum number of files to upload (overrides config) |

**Examples:**
```bash
mgrep watch                           # index the current repository and watch for changes
mgrep watch --max-file-size 1048576   # limit uploads to files under 1MB
mgrep watch --max-file-count 5000     # limit sync to 5000 changed files or fewer
```

## Architecture

- Files are chunked and embedded locally using Qwen3-Embedding via DeepInfra, then stored in a LanceDB vector database under `~/.mgrep/lancedb/`.
- Searches combine vector similarity (ANN) and full-text search (BM25), fused with Reciprocal Rank Fusion.
- Reranking uses Qwen3-Reranker via DeepInfra and is enabled by default (disable with `--no-rerank`).
- Synthesized answers and agentic query planning use Alibaba Cloud DashScope (Qwen3.5-plus) via the Responses API.
- All embeddings and indexes are stored locally — only API calls to DeepInfra/DashScope leave your machine.

## Configuration

mgrep can be configured via config files, environment variables, or CLI flags.

### Config File

Create a `.mgreprc.yaml` (or `.mgreprc.yml`) in your project root for local configuration, or `~/.config/mgrep/config.yaml` (or `config.yml`) for global configuration.

```yaml
# Maximum file size in bytes to upload (default: 4MB)
maxFileSize: 5242880

# Maximum number of files to sync (upload/delete) per operation (default: 10000)
maxFileCount: 5000

# Concurrency for sync operations (default: 20)
syncConcurrency: 10

# Override the embedding model (default: Qwen/Qwen3-Embedding-4B)
embedModel: Qwen/Qwen3-Embedding-4B

# Embedding dimensions (default: 2560)
embedDimensions: 2560

# Override the rerank model (default: Qwen/Qwen3-Reranker-4B)
rerankModel: Qwen/Qwen3-Reranker-4B

# Override the LLM model for answers (default: qwen3.5-plus)
llmModel: qwen3.5-plus

# Custom LanceDB storage path (default: ~/.mgrep/lancedb)
lancedbPath: /path/to/lancedb
```

**Configuration precedence** (highest to lowest):
1. CLI flags (`--max-file-size`, `--max-file-count`)
2. Environment variables (`MGREP_MAX_FILE_SIZE`, `MGREP_MAX_FILE_COUNT`, …)
3. Local config file (`.mgreprc.yaml` in project directory)
4. Global config file (`~/.config/mgrep/config.yaml`)
5. Default values

## Environment Variables

### API Keys

- `DEEPINFRA_API_KEY`: DeepInfra API key for embeddings and reranking (required)
- `DASHSCOPE_API_KEY`: Alibaba Cloud DashScope API key for responses (required for `--answer` / `--agentic`)

### Store

- `MGREP_STORE`: Override the default store name (default: `mgrep`)
- `MGREP_LANCEDB_PATH`: Override the LanceDB storage path

### Search Options

- `MGREP_MAX_COUNT`: Maximum number of results to return (default: `10`)
- `MGREP_CONTENT`: Show content of the results (set to `1` or `true` to enable)
- `MGREP_ANSWER`: Generate an answer based on the results (set to `1` or `true` to enable)
- `MGREP_AGENTIC`: Enable agentic search (set to `1` or `true` to enable)
- `MGREP_SYNC`: Sync files before searching (set to `1` or `true` to enable)
- `MGREP_DRY_RUN`: Enable dry run mode (set to `1` or `true` to enable)
- `MGREP_RERANK`: Enable reranking (set to `0` or `false` to disable, default: enabled)

### Sync Options

- `MGREP_MAX_FILE_SIZE`: Maximum file size in bytes to upload (default: `4194304` / 4MB)
- `MGREP_MAX_FILE_COUNT`: Maximum number of files to sync per operation (default: `10000`)
- `MGREP_SYNC_CONCURRENCY`: Concurrency for sync operations (default: `20`)

### Model Options

- `MGREP_EMBED_MODEL`: Embedding model to use (default: `Qwen/Qwen3-Embedding-4B`)
- `MGREP_EMBED_DIMENSIONS`: Embedding dimensions (default: `2560`)
- `MGREP_RERANK_MODEL`: Rerank model to use (default: `Qwen/Qwen3-Reranker-4B`)
- `MGREP_LLM_MODEL`: LLM model for answers (default: `qwen3.5-plus`)

**Examples:**
```bash
# Set default max results to 25
export MGREP_MAX_COUNT=25
mgrep "search query"

# Always show content in results
export MGREP_CONTENT=1
mgrep "search query"

# Disable reranking globally
export MGREP_RERANK=0
mgrep "search query"
```

Note: Command-line options always override environment variables.

## Development

```bash
pnpm install
pnpm build        # TypeScript compile
pnpm test         # bats integration tests
pnpm format       # biome formatting + linting
pnpm typecheck    # type-check without emitting
```

The executable lives at `dist/index.js` (built from TypeScript via `tsc`).

### Testing

```bash
pnpm test
```

Tests are written using [bats](https://bats-core.readthedocs.io/en/stable/) and use a `TestStore` in-memory backend so no real API keys are required.

## Troubleshooting

- **API key errors**: Run `mgrep validate` to check your `DEEPINFRA_API_KEY` and `DASHSCOPE_API_KEY` are correctly set and working.
- **Watcher feels slow**: Lower `syncConcurrency` in your config if you're hitting API rate limits, or raise it for faster initial sync on large repos.
- **Store schema mismatch**: If you change `embedModel` or `embedDimensions`, delete the store directory (`~/.mgrep/lancedb/<store-name>/`) and re-index with `mgrep watch`.
- **Unknown option errors**: Unrecognized flags now produce an error — check `mgrep --help` for supported options.

## License

Apache-2.0. See the [LICENSE](https://opensource.org/licenses/Apache-2.0) file for details.
