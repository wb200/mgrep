<div align="center">
  <h1>mgrep</h1>
  <p><em>Local semantic code search backed by LanceDB, DeepInfra, and DashScope.</em></p>
  <a href="https://www.npmjs.com/package/@wb200/mgrep"><img src="https://badge.fury.io/js/%40wb200%2Fmgrep.svg" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
</div>

## Why mgrep?

- Ask your repo questions in natural language instead of guessing exact symbols.
- Keep a local LanceDB index on disk under `~/.mgrep/lancedb/`.
- Combine vector retrieval, full-text search, reranking, and optional answer synthesis.
- Work directly in the CLI or wire it into coding agents.

`mgrep` is for local repository search. It does not do web search in this fork.

```bash
# index a project
mgrep watch

# search semantically
mgrep "where do we set up auth?"

# synthesize an answer from retrieved local results
mgrep -a "how does the sync pipeline work?"
```

## Quick Start

1. **Install**
   ```bash
   npm install -g @wb200/mgrep
   ```

2. **Set required API keys**
   ```bash
   export DEEPINFRA_API_KEY=your_deepinfra_key
   export DASHSCOPE_API_KEY=your_dashscope_key
   ```
   - `DEEPINFRA_API_KEY` is used for embeddings and reranking.
   - `DASHSCOPE_API_KEY` is used for synthesized answers and agentic query planning.
   - Both keys are required for normal use in this fork.

3. **Validate configuration**
   ```bash
   mgrep validate
   ```

4. **Index a project**
   ```bash
   cd path/to/repo
   mgrep watch
   ```

5. **Search**
   ```bash
   mgrep "where do we set up auth?"
   mgrep -m 25 "store schema"
   mgrep -a "how is rate limiting implemented?"
   ```

## What It Does

`mgrep` keeps a local searchable index of your repository.

- File discovery respects `.gitignore`, `.mgrepignore`, hidden files, and built-in ignore patterns.
- Indexed content is chunked and stored locally in LanceDB.
- Embeddings and reranking are done through DeepInfra.
- Answer synthesis and agentic planning are done through DashScope.

This means the index itself is local, but text chunks are sent to provider APIs during embedding, reranking, and answer-generation flows.

## Commands

Top-level commands:

- `mgrep` or `mgrep search <pattern> [path]`
- `mgrep watch`
- `mgrep validate`
- `mgrep install-claude-code`
- `mgrep uninstall-claude-code`
- `mgrep install-codex`
- `mgrep uninstall-codex`
- `mgrep install-opencode`
- `mgrep uninstall-opencode`
- `mgrep install-droid`
- `mgrep uninstall-droid`
- `mgrep mcp`

Global options:

- `--store <string>`: logical store name to use, default `mgrep`

### `mgrep search`

`mgrep search` is the default command. It searches the current directory unless you pass a path.

Arguments:

- `<pattern>`: natural-language query
- `[path]`: optional search root or scoped path

Options:

- `-m, --max-count <max_count>`: maximum number of results, default `10`
- `-c, --content`: include matched chunk content in output
- `-a, --answer`: synthesize an answer from retrieved local results
- `-s, --sync`: sync files before searching
- `-d, --dry-run`: preview sync work without uploading or deleting
- `--no-rerank`: disable reranking
- `--max-file-size <bytes>`: override upload size limit for sync
- `--max-file-count <count>`: override sync file-count limit
- `--agentic`: enable multi-query planning before retrieval

Examples:

```bash
mgrep "Where is the auth middleware configured?"
mgrep "How are chunks defined?" src/lib
mgrep -m 5 "maximum concurrent workers"
mgrep -c "How does caching work?"
mgrep -a "How is rate limiting implemented?"
mgrep --agentic -a "How does authentication work and where is it configured?"
mgrep --sync "Where is the API server started?"
mgrep --sync --dry-run "search query"
```

### `mgrep watch`

`mgrep watch` performs an initial sync, then keeps the current project directory in sync via file watching.

Options:

- `-d, --dry-run`: preview what would be uploaded or deleted
- `--max-file-size <bytes>`: override upload size limit
- `--max-file-count <count>`: override sync file-count limit

Examples:

```bash
mgrep watch
mgrep watch --dry-run
mgrep watch --max-file-size 1048576
mgrep watch --max-file-count 5000
```

### `mgrep validate`

Validates both provider configurations by exercising embeddings, rerank, and responses.

```bash
mgrep validate
```

### Agent Install Commands

`mgrep` includes helper installers for several agent environments:

- `mgrep install-claude-code`
- `mgrep install-codex`
- `mgrep install-opencode`
- `mgrep install-droid`

These integrations are focused on local search plus background indexing. After installation, `mgrep` warns that background sync will run automatically for supported agent flows.

### `mgrep mcp`

Starts the internal MCP server process used by some integrations.

This command is not needed for normal CLI use.

## Configuration

Configuration sources, highest precedence first:

1. CLI flags
2. Environment variables
3. Local config file: `.mgreprc.yaml` or `.mgreprc.yml`
4. Global config file: `~/.config/mgrep/config.yaml` or `~/.config/mgrep/config.yml`
5. Built-in defaults

### Config File

Example:

```yaml
maxFileSize: 5242880
maxFileCount: 5000
syncConcurrency: 10
embedModel: Qwen/Qwen3-Embedding-4B
embedDimensions: 2560
rerankModel: Qwen/Qwen3-Reranker-4B
llmModel: qwen3.5-plus
lancedbPath: /path/to/lancedb
```

Defaults:

- `maxFileSize`: `4194304` bytes
- `maxFileCount`: `10000`
- `syncConcurrency`: `20`
- `lancedbPath`: `~/.mgrep/lancedb`
- `embedModel`: `Qwen/Qwen3-Embedding-4B`
- `embedDimensions`: `2560`
- `rerankModel`: `Qwen/Qwen3-Reranker-4B`
- `llmModel`: `qwen3.5-plus`

### Environment Variables

Provider keys:

- `DEEPINFRA_API_KEY`
- `DASHSCOPE_API_KEY`

Store:

- `MGREP_STORE`
- `MGREP_LANCEDB_PATH`

Search behavior:

- `MGREP_MAX_COUNT`
- `MGREP_CONTENT`
- `MGREP_ANSWER`
- `MGREP_AGENTIC`
- `MGREP_AGENT`
- `MGREP_SYNC`
- `MGREP_DRY_RUN`
- `MGREP_RERANK`

Sync behavior:

- `MGREP_MAX_FILE_SIZE`
- `MGREP_MAX_FILE_COUNT`
- `MGREP_SYNC_CONCURRENCY`

Model overrides:

- `MGREP_EMBED_MODEL`
- `MGREP_EMBED_DIMENSIONS`
- `MGREP_RERANK_MODEL`
- `MGREP_LLM_MODEL`

## Search Behavior and Limits

- `mgrep` is text-first. Non-text and binary files are skipped.
- Built-in ignore patterns include `*.lock`, `*.bin`, `*.ipynb`, `*.pyc`, `*.safetensors`, `*.sqlite`, and `*.pt`.
- Hidden files are ignored.
- `watch` and `search --sync` refuse to operate on the home directory or parent directories of it.
- Sync is bounded by `maxFileSize` and `maxFileCount`.

## Output

Search results are printed as:

```text
./path/to/file:line-start-line-end (score% match)
```

With `--content`, chunk text is included below each result.

With `--answer`, `mgrep` prints the synthesized answer and the cited local source chunks it used.

## Architecture

- Local storage: LanceDB under `~/.mgrep/lancedb/`
- Retrieval: vector similarity + full-text search
- Fusion: reciprocal-rank fusion
- Reranking: DeepInfra
- Answer synthesis and agentic planning: DashScope Responses API

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm format
pnpm typecheck
```

The built CLI entrypoint is `dist/index.js`.

## Troubleshooting

- Missing API keys: run `mgrep validate`
- Sync blocked at home directory: run from a specific project subdirectory
- Store incompatibility after changing embedding settings: delete the affected store under `~/.mgrep/lancedb/<store-name>/` and re-index
- Slow initial indexing: lower `syncConcurrency` if you are rate-limited, or tune file limits for very large repos

## License

Apache-2.0. See [LICENSE](./LICENSE).
