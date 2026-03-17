# mgrep Practical Guide

This guide focuses on real workflows with the current `@wb200/mgrep` fork.

Use the main [`README`](../README.md) for installation, command reference, and configuration details. Use this guide for examples and everyday patterns.

## Before You Start

Install `mgrep` and set both required provider keys:

```bash
npm install -g @wb200/mgrep

export DEEPINFRA_API_KEY=your_deepinfra_key
export DASHSCOPE_API_KEY=your_dashscope_key
```

Then validate:

```bash
mgrep validate
```

## Core Workflow

The normal workflow is:

1. Change into a project directory.
2. Build or refresh the local index with `mgrep watch`.
3. Ask semantic questions with `mgrep`.

Example:

```bash
cd ~/code/my-project
mgrep watch

mgrep "Where is the auth middleware configured?"
mgrep -a "How does rate limiting work in this service?"
```

## Manual Usage Patterns

### Index a project

```bash
cd path/to/repo
mgrep watch
```

This performs an initial sync and then watches the current project directory for changes.

If you want to preview work without uploading:

```bash
mgrep watch --dry-run
```

### Search semantically

```bash
mgrep "What code parsers are available?"
mgrep "How are chunks defined?" src/lib
```

Use this when you know the concept you want but not the exact symbol or filename.

### Limit result count

```bash
mgrep -m 5 "Where is the auth middleware configured?" src
```

### Include matched content

```bash
mgrep -c "Where do we validate user input for signup?"
```

This is useful when you want to skim results without opening files immediately.

### Ask for a synthesized answer

```bash
mgrep -a "How does rate limiting work in this service?"
```

This retrieves relevant local chunks, then synthesizes an answer from those results.

### Use agentic search for broader questions

```bash
mgrep --agentic -a "How does authentication work and where is it configured?"
```

This asks `mgrep` to plan multiple sub-queries before retrieving and answering.

### Sync before searching

```bash
mgrep --sync "Where is the API server started?"
```

This is useful when you want an up-to-date result set without starting a long-running watcher.

### Preview sync changes

```bash
mgrep --sync --dry-run "search query"
```

This shows what would be uploaded or deleted before actually changing the local store.

## Classic grep vs mgrep

Use `grep` or `rg` when:

- you know the exact symbol
- you need exact-match refactoring support
- you need regex-based auditing

Use `mgrep` when:

- you know the concept, not the exact string
- you want architectural or behavioral discovery
- you are onboarding to an unfamiliar codebase

Example:

```bash
rg "auth" src
mgrep "Where is the auth middleware configured?" src
```

The first is exact-string search. The second is intent-based search.

## Working With Path Scopes

You can narrow search to a subtree:

```bash
mgrep "How is error handling wired up?" src/api
mgrep "How are chunks defined?" src/lib
```

This is often the simplest way to keep results focused without changing your query wording.

## Working With Agent Integrations

`mgrep` includes install helpers for:

- Claude Code
- Codex
- OpenCode
- Factory Droid

Examples:

```bash
mgrep install-claude-code
mgrep install-codex
mgrep install-opencode
mgrep install-droid
```

These integrations are designed around local search plus background indexing. Some of them start background sync automatically for agent sessions.

## Important Limits and Behavior

This fork is local-repo search only.

- No web search support
- No PDF search support
- No image search support
- Non-text and binary files are skipped

`mgrep` is text-first and works best on code, docs, config, and other plain-text repository content.

Built-in ignore patterns skip several file types by default, including:

- `*.lock`
- `*.bin`
- `*.ipynb`
- `*.pyc`
- `*.safetensors`
- `*.sqlite`
- `*.pt`

It also respects:

- `.gitignore`
- `.mgrepignore`
- hidden files

## Configuration Examples

### Limit file size for indexing

```bash
mgrep watch --max-file-size 1048576
```

### Limit sync surface area

```bash
mgrep watch --max-file-count 5000
```

### Persist defaults in a local config file

Create `.mgreprc.yaml`:

```yaml
maxFileSize: 5242880
maxFileCount: 5000
syncConcurrency: 10
embedModel: Qwen/Qwen3-Embedding-4B
embedDimensions: 2560
rerankModel: Qwen/Qwen3-Reranker-4B
llmModel: qwen3.5-plus
```

## Troubleshooting

### Missing API keys

```bash
mgrep validate
```

Both `DEEPINFRA_API_KEY` and `DASHSCOPE_API_KEY` must be set.

### Sync refuses to run

`watch` and `search --sync` do not allow indexing the home directory or its parents.

Run them from a specific project subdirectory instead.

### Non-text files do not appear

That is expected in the current fork. `mgrep` skips non-text and binary content.

### Results feel stale

Run:

```bash
mgrep watch
```

or:

```bash
mgrep --sync "your query"
```

## Further Reading

- Main reference: [`../README.md`](../README.md)
- Configuration and behavior: see the main README sections on commands, config, and troubleshooting
