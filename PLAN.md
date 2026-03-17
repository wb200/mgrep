# Surgical Backend Swap to Singapore Model Studio + LanceDB

## Summary

- Keep the current CLI flow and `Store` seam intact, and replace the backend mostly behind `src/lib/store.ts`, `src/lib/context.ts`, and `src/lib/config.ts`.
- Use Alibaba Cloud International Singapore only:
  - Responses API for answer/agentic with `qwen3.5-plus`
  - OpenAI-compatible embeddings for `text-embedding-v4`
  - Singapore rerank endpoint for `qwen3-rerank`
- Use LanceDB locally for both vector search and BM25 FTS.
- Keep phase 1 text/code-only. Disable unsupported remote retrieval, PDF, and image ingestion explicitly.

## Key Changes

- Replace `@mixedbread/sdk` with a local `LanceStore` implementation.
  - Preserve the existing `Store` interface methods so `search`, `watch`, sync, and formatting code need minimal edits.
  - Replace Mixedbread chunk/result types with local types that preserve the current text-result contract: `score`, `metadata.path`, `generated_metadata.start_line`, `generated_metadata.num_lines`.
- Replace `createStore()` with a local factory.
  - No remote store client, OAuth, JWT refresh, orgs, or cloud-side file listing.
  - `refreshClient()` becomes a no-op.
- Add a provider wrapper with three separate call paths because the Singapore endpoints differ by feature.
  - `OpenAI` client for embeddings:
    - base URL `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
    - `embeddings.create({ model: "text-embedding-v4", dimensions })`
  - `OpenAI` client for answers/agentic:
    - base URL `https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1`
    - `responses.create({ model: "qwen3.5-plus", input, enable_thinking })`
  - direct `fetch` for rerank:
    - `POST https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks`
    - model `qwen3-rerank`
- Do not use Chat Completions anywhere in the rewrite.
  - All synthesized answering and agentic planning must use Responses API only.
- Do not use built-in remote retrieval tools from Responses API; keep retrieval local and deterministic.
- Implement a local LanceDB store per logical `--store`.
  - Base path from `MGREP_LANCEDB_PATH`, default `~/.mgrep/lancedb`.
  - Store-local data:
    - `files` table for sync metadata
    - `chunks` table for searchable content
    - `meta.json` for active embedding model, dimensions, rerank model, answer model, and chunking version
  - If embedding model or dimensions change, fail with a rebuild-required error instead of mixing incompatible vectors.
- Implement local text ingestion and chunking.
  - Keep existing file discovery, ignore, mtime, hash, and dry-run behavior.
  - Support text/code files only in this phase.
  - Chunk in line-preserving windows so the existing line-range formatter still works.
  - Default chunking:
    - `maxCharsPerChunk = 2000`
    - `maxLinesPerChunk = 80`
    - `overlapLines = 8`
- Implement hybrid retrieval in code, using LanceDB for both modalities.
  - Run vector search in LanceDB on the chunk embeddings.
  - Run BM25/FTS search in LanceDB on chunk text.
  - Merge the two candidate sets in application code with reciprocal-rank fusion.
  - If rerank is enabled, call `qwen3-rerank` on the fused candidate pool and reorder the final results.
  - This avoids depending on LanceDB JS hybrid/reranker integration details while still using LanceDB as the hybrid DB.
- Reimplement the current search flags with minimal external behavior change.
  - `MGREP_RERANK` / `--no-rerank`: same semantics, now toggles external rerank.
  - `MGREP_ANSWER` / `--answer`: retrieve locally, then synthesize with `qwen3.5-plus` via Responses API.
  - `MGREP_AGENTIC` / `--agentic`: use a first Responses API call to propose 3-5 subqueries, retrieve for each, deduplicate, optionally rerank, then synthesize the final answer with another Responses API call.
  - Keep the answer formatter contract by requiring the model to emit `<cite i="N" />` tags mapped to the retrieved source array.
- Use Responses API deterministically.
  - Do not rely on `previous_response_id`; keep each planning/answer call self-contained so provider-side hidden state does not affect search behavior.
  - Default `enable_thinking: true` for agentic planning and final synthesized answers.
- Replace the config/auth surface.
  - canonical env vars:
    - `DASHSCOPE_API_KEY`
    - `MGREP_STORE`
    - `MGREP_LANCEDB_PATH`
    - `MGREP_EMBED_MODEL`
    - `MGREP_EMBED_DIMENSIONS`
    - `MGREP_RERANK_MODEL`
    - `MGREP_LLM_MODEL`
  - keep existing:
    - `MGREP_RERANK`
    - `MGREP_ANSWER`
    - `MGREP_AGENTIC`
    - sync-size/count vars
  - compatibility aliases for one migration cycle:
    - `MGREP_AGENT` as alias to `MGREP_AGENTIC`
    - `MXBAI_STORE` as alias to `MGREP_STORE`
  - do not alias `MXBAI_API_KEY` to `DASHSCOPE_API_KEY`
- Full CLI replacement, but with low disruption.
  - `login` becomes a configuration validation command that pings the Singapore embedding, rerank, and responses endpoints.
  - `logout` becomes a no-op guidance command explaining that no cloud session is persisted and `DASHSCOPE_API_KEY` controls access.
  - remove `switch-org`
  - keep `install-*` commands, but replace `ensureAuthenticated()` with `ensureConfigured()`
- Disable unsupported backend-specific features in phase 1.
  - unsupported remote retrieval returns a clear unsupported-feature error
  - PDF/image files are skipped with explicit warnings
  - keep MCP/watch integration working against the local store

## Tests

- Keep `TestStore` for offline CLI tests, but update it to the new config and unsupported-feature surface.
- Add integration coverage for:
  - `watch` creates a local store and indexes text/code files
  - file modifications update stored chunks and hashes
  - deletions remove stale chunks
  - path-prefix scoping still works
  - rerank on/off preserves output shape
  - `--answer` returns citations compatible with the existing formatter
  - `--agentic` performs bounded multi-query retrieval
  - unsupported remote retrieval fails clearly
  - PDF/image/binary files are skipped as expected
  - `switch-org` is absent
  - `login` validates Singapore endpoints instead of OAuth
- Add opt-in live smoke tests gated by `DASHSCOPE_API_KEY`.
  - verify `text-embedding-v4` on Singapore embeddings endpoint
  - verify `qwen3-rerank` on Singapore rerank endpoint
  - verify `qwen3.5-plus` on Singapore Responses API
  - fail immediately if any code path points to Beijing or another region

## Assumptions and Defaults

- The current local checkout is not synced to the fork yet; it is on `main` tracking `mixedbread-ai/mgrep`, not `wb200/mgrep`.
- The managed Singapore docs do not document the exact model IDs `Qwen/Qwen3-Embedding-0.6B`, `Qwen/Qwen3-Embedding-4B`, `Qwen/Qwen3-Reranker-0.6B`, or `Qwen/Qwen3-Reranker-4B` for Model Studio managed endpoints.
  - default managed models therefore remain `text-embedding-v4` and `qwen3-rerank`
  - model-string overrides stay configurable in case the account exposes additional Singapore-supported IDs
- There is a documentation inconsistency on rerank availability.
  - the dedicated `Text rerank` API page documents `qwen3-rerank` in Singapore
  - the broader model-list page still says text rerank is Beijing-only
  - implementation should treat the dedicated rerank API doc as the source of truth and validate availability during `login` / config-check
- Phase 1 intentionally excludes:
  - remote internet retrieval
  - PDF/image ingestion
  - any China-region endpoint
  - any Chat Completions usage
