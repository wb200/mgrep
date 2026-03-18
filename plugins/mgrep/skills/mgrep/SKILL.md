---
name: mgrep
description: "Use `mgrep` for hybrid semantic local search when you know the concept but not the exact string. It helps you find likely files and line ranges, then verify details with `rg`, `grep`, or `ast-grep`."
license: Apache 2.0
---

## When to Use

Use `mgrep` when you need concept-level or intent-level discovery in a local codebase or document set.

Good fits:

- You know the behavior, feature, or responsibility, but not the exact symbol or wording
- You want likely files or chunks before doing exact verification
- You are exploring an unfamiliar codebase and need fast architectural entry points

Prefer other tools when the task is exact or exhaustive:

- Exact string or regex search: `rg` or `grep`
- Syntax-aware structural search: `ast-grep`
- File or path discovery: `fd`, glob tools, or directory listing tools

## What `mgrep` Does

`mgrep` performs hybrid local search over the indexed repository. It is best for semantic discovery, not exhaustive verification.

Write queries in natural language and describe the code by behavior, purpose, or architecture.

## Recommended Workflow

1. Use `mgrep` to find candidate files and line ranges
2. Open the most relevant hits
3. Use `rg`, `grep`, or `ast-grep` to confirm exact implementation details

## Query Guidance

Prefer specific conceptual queries over short vague terms.

Better:

```bash
mgrep "where is auth handled?"
mgrep "retry configuration logic" src/
mgrep "how are chunks defined?" src/
mgrep "what starts background indexing?" src/
```

Less useful:

```bash
mgrep "auth"
mgrep "parser"
mgrep "config"
```

## Useful Options

- `-a, --answer`: summarize the retrieved local results
- `-m, --max-count <n>`: limit the number of returned matches

## Examples

```bash
mgrep "where is auth handled?"
mgrep "retry configuration logic" src/
mgrep -m 5 "how are chunks defined?" src/
mgrep -a "how does indexing work?" src/
```

## Boundaries

Use `mgrep` to narrow the search space semantically. Use exact or structural tools to verify final answers.
