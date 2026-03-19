# mgrep Practical Guide

This guide focuses on real workflows with the current `@wb200/mgrep` fork.

Use the main [`README`](../README.md) for installation, command reference, and configuration details. Use this guide for examples and everyday patterns.

## Before You Start

Install `mgrep` and set the required provider key:

```bash
npm install -g @wb200/mgrep

export DEEPINFRA_API_KEY=your_deepinfra_key
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

## Hybrid Search Workflow

Use `mgrep` alongside traditional local search tools:

- `mgrep` for semantic or intent-based discovery
- `rg` or `grep` for exact strings and regex audits
- `ast-grep` for syntax-aware structural search

Typical workflow:

```bash
mgrep "Where is rate limiting configured?" src
rg "rateLimit" src
```

The first step narrows the search space semantically. The second step verifies exact implementation details.

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

## Understanding Stores In Practice

The `--store` flag chooses the logical index name that `mgrep` uses.

This matters a lot once you start indexing more than one folder.

### Default behavior

If you do nothing, `mgrep` uses the default store:

```bash
mgrep
```

So:

```bash
mgrep watch
```

really means:

```bash
mgrep --store mgrep watch
```

and:

```bash
mgrep "query"
```

really means:

```bash
mgrep --store mgrep "query"
```

You can change that shell-wide with:

```bash
export MGREP_STORE=my-store
```

### Important consequence

If you indexed with a custom store name:

```bash
cd /home/wb200/.factory/specs
mgrep --store factory-specs watch
```

then later run:

```bash
mgrep "query"
```

you are **not** searching `factory-specs`.

You are searching the default store `mgrep`.

To search the index you created, do this instead:

```bash
mgrep --store factory-specs "query"
```

### One command, one store

`mgrep` does not search across all stores automatically.

Each invocation searches exactly one store:

- `--store ...`
- or `MGREP_STORE`
- or the default `mgrep`

### Additive multi-folder indexing

If you watch two different folders using the same store name, the contents combine additively.

Example:

```bash
cd ~/code/project-a
mgrep --store shared watch

cd ~/code/project-b
mgrep --store shared watch
```

Now store `shared` contains both:

- `~/code/project-a/...`
- `~/code/project-b/...`

The second watch does not wipe the first.

### Why that works

Sync deletion is scoped only to the folder subtree being watched or synced.

So if you remove a file under `project-a`, syncing `project-a` removes that stale entry.
But syncing `project-a` does not delete `project-b` from the same store.

### Current directory still matters

Even within a shared store, search is path-scoped.

If you run:

```bash
cd ~/code/project-a
mgrep --store shared "auth middleware"
```

you search store `shared`, but results are filtered to the current folder path.

You can also target another subtree explicitly:

```bash
mgrep --store shared "auth middleware" ~/code/project-b
```

### Recommended patterns

For most users, one store per project is the least confusing:

```bash
cd ~/code/project-a
mgrep --store project-a watch

cd ~/code/project-b
mgrep --store project-b watch
```

Then search using the same store:

```bash
mgrep --store project-a "query"
mgrep --store project-b "query"
```

If you intentionally want one combined index across multiple roots, reuse the same store name on purpose:

```bash
cd ~/notes
mgrep --store personal watch

cd ~/specs
mgrep --store personal watch
```

That creates one shared logical index named `personal`.

## Classic grep vs mgrep vs ast-grep

Use `grep` or `rg` when:

- you know the exact symbol
- you need exact-match refactoring support
- you need regex-based auditing

Use `ast-grep` when:

- you need syntax-aware structural matches
- you are preparing a refactor across many files

Use `mgrep` when:

- you know the concept, not the exact string
- you want architectural or behavioral discovery
- you are onboarding to an unfamiliar codebase

Example:

```bash
rg "auth" src
ast-grep --pattern 'router.use($$$ARGS)' src
mgrep "Where is the auth middleware configured?" src
```

The first is exact-string search. The second is syntax-aware structural search. The third is intent-based search.

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

`mgrep` is text-first and allowlist-first. A file is indexed only if it:

1. matches `allowedExtensions`, `allowedNames`, or `allowedDotfiles`
2. is not inside a hidden directory
3. is not excluded by `.gitignore`, `.mgrepignore`, or `ignorePatterns`
4. passes text or binary detection

This means the paradigm has shifted from ignore-first filtering to
allowlist-first permissioning.

### Default Indexed Files

Config and structured text:

- `cfg`
- `conf`
- `hjson`
- `ini`
- `json`
- `json5`
- `jsonc`
- `properties`
- `toml`
- `yaml`
- `yml`

Developer artifacts:

- `diff`
- `http`
- `log`
- `mermaid`
- `mmd`
- `patch`
- `plantuml`
- `po`
- `pot`
- `puml`
- `rest`

Docs and notes:

- `adoc`
- `asciidoc`
- `md`
- `mdx`
- `rst`
- `txt`

Exact filenames:

- `Brewfile`
- `CHANGELOG`
- `config`
- `Config`
- `Containerfile`
- `COPYING`
- `Dockerfile`
- `Earthfile`
- `GNUmakefile`
- `Jenkinsfile`
- `Justfile`
- `justfile`
- `LICENSE`
- `Makefile`
- `makefile`
- `NOTICE`
- `Pipfile`
- `Procfile`
- `README`
- `Snakefile`
- `Tiltfile`
- `Vagrantfile`

Exact hidden basenames:

- `.bumpversion.cfg`
- `.coveragerc`
- `.dockerignore`
- `.editorconfig`
- `.eslintignore`
- `.eslintrc`
- `.flake8`
- `.gitattributes`
- `.gitignore`
- `.gitmodules`
- `.isort.cfg`
- `.mypy.ini`
- `.pre-commit-config.yaml`
- `.prettierrc`
- `.pylintrc`
- `.pyre_configuration`
- `.python-version`
- `.ruff.toml`
- `.tool-versions`
- `.yamllint`

Markup and templates:

- `css`
- `htm`
- `html`
- `j2`
- `jinja`
- `jinja2`
- `less`
- `sass`
- `scss`
- `template`
- `tmpl`
- `tpl`
- `xml`
- `xsd`
- `xsl`
- `xslt`

Python and related:

- `ipynb`
- `pxd`
- `pxi`
- `py`
- `pyi`
- `pyw`
- `pyx`

Queries and infra:

- `cmake`
- `cue`
- `gql`
- `graphql`
- `graphqls`
- `hcl`
- `mk`
- `nix`
- `proto`
- `rego`
- `sql`
- `tf`
- `tfvars`

Shell and automation:

- `bash`
- `csh`
- `fish`
- `ksh`
- `ps1`
- `psm1`
- `sh`
- `tcsh`
- `zsh`

Web and mixed-language repo text:

- `cjs`
- `cts`
- `js`
- `jsx`
- `mjs`
- `mts`
- `svelte`
- `ts`
- `tsx`
- `vue`

### Default Deny Patterns

- `*.bin`
- `*.lock`
- `*.pt`
- `*.pyc`
- `*.safetensors`
- `*.sqlite`

These patterns still apply after allowlist admission.

### Important Notes

- `.gitignore`
- `.mgrepignore`
- Hidden directories such as `.github/` remain excluded by default
- `.doc` and `.docx` are not indexed in the current fork because ingestion is still text-only

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
maxFileSize: 4194304
maxFileCount: 10000
syncConcurrency: 20
lancedbPath: ~/.mgrep/lancedb
embedModel: Qwen/Qwen3-Embedding-4B
embedDimensions: 2560
rerankModel: Qwen/Qwen3-Reranker-4B
llmModel: MiniMaxAI/MiniMax-M2.5

allowedExtensions:
  # Config and structured text
  - cfg
  - conf
  - hjson
  - ini
  - json
  - json5
  - jsonc
  - properties
  - toml
  - yaml
  - yml
  # Developer artifacts
  - diff
  - http
  - log
  - mermaid
  - mmd
  - patch
  - plantuml
  - po
  - pot
  - puml
  - rest
  # Docs and notes
  - adoc
  - asciidoc
  - md
  - mdx
  - rst
  - txt
  # Markup and templates
  - css
  - htm
  - html
  - j2
  - jinja
  - jinja2
  - less
  - sass
  - scss
  - template
  - tmpl
  - tpl
  - xml
  - xsd
  - xsl
  - xslt
  # Python and related
  - ipynb
  - pxd
  - pxi
  - py
  - pyi
  - pyw
  - pyx
  # Queries and infra
  - cmake
  - cue
  - gql
  - graphql
  - graphqls
  - hcl
  - mk
  - nix
  - proto
  - rego
  - sql
  - tf
  - tfvars
  # Shell and automation
  - bash
  - csh
  - fish
  - ksh
  - ps1
  - psm1
  - sh
  - tcsh
  - zsh
  # Web and mixed-language repo text
  - cjs
  - cts
  - js
  - jsx
  - mjs
  - mts
  - svelte
  - ts
  - tsx
  - vue

allowedNames:
  - Brewfile
  - CHANGELOG
  - config
  - Config
  - Containerfile
  - COPYING
  - Dockerfile
  - Earthfile
  - GNUmakefile
  - Jenkinsfile
  - Justfile
  - justfile
  - LICENSE
  - Makefile
  - makefile
  - NOTICE
  - Pipfile
  - Procfile
  - README
  - Snakefile
  - Tiltfile
  - Vagrantfile

allowedDotfiles:
  - .bumpversion.cfg
  - .coveragerc
  - .dockerignore
  - .editorconfig
  - .eslintignore
  - .eslintrc
  - .flake8
  - .gitattributes
  - .gitignore
  - .gitmodules
  - .isort.cfg
  - .mypy.ini
  - .pre-commit-config.yaml
  - .prettierrc
  - .pylintrc
  - .pyre_configuration
  - .python-version
  - .ruff.toml
  - .tool-versions
  - .yamllint

ignorePatterns:
  - "*.bin"
  - "*.lock"
  - "*.pt"
  - "*.pyc"
  - "*.safetensors"
  - "*.sqlite"
```

## Troubleshooting

### Missing API keys

```bash
mgrep validate
```

`DEEPINFRA_API_KEY` must be set.

### Sync refuses to run

`watch` and `search --sync` do not allow indexing the home directory or its parents.

Run them from a specific project subdirectory instead.

### Why a file may not be indexed

A file can be skipped because:

- its extension or basename is not allowlisted
- it lives under a hidden directory such as `.github/`
- `.gitignore`, `.mgrepignore`, or `ignorePatterns` exclude it
- it is binary or non-text

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
