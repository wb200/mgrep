import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Table } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
import type { MgrepConfig } from "./config.js";
import type { ModelStudioClient } from "./model-studio.js";

const CHUNKS_TABLE = "chunks";
const FILES_TABLE = "files";
const META_FILE = "meta.json";
const MAX_CHUNK_CHARS = 2000;
const MAX_CHUNK_LINES = 80;
const CHUNK_OVERLAP_LINES = 8;
const DEFAULT_TOP_K = 10;
const CANDIDATE_MULTIPLIER = 5;
const MIN_CANDIDATES = 20;
const MAX_RERANK_DOCUMENTS = 50;

export interface FileMetadata {
  path: string;
  hash: string;
  mtime?: number;
}

export interface GeneratedMetadata {
  start_line: number;
  num_lines: number;
  type?: string;
}

export interface TextChunk {
  type: "text";
  text: string;
  score: number;
  metadata: FileMetadata;
  chunk_index: number;
  generated_metadata: GeneratedMetadata;
}

export type ChunkType = TextChunk;

export interface StoreFile {
  external_id: string | null;
  metadata: FileMetadata | null;
}

export interface UploadFileOptions {
  external_id: string;
  overwrite?: boolean;
  metadata?: FileMetadata;
  /** When true, skip per-upload FTS index maintenance. Caller must invoke ensureIndices() after bulk operations. */
  deferIndexing?: boolean;
}

export interface SearchResponse {
  data: ChunkType[];
}

export interface AskResponse {
  answer: string;
  sources: ChunkType[];
}

export interface CreateStoreOptions {
  name: string;
  description?: string;
}

export interface StoreInfo {
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  counts: {
    pending: number;
    in_progress: number;
  };
}

export interface SearchOptions {
  rerank?: boolean;
  agentic?: boolean;
}

export interface ListFilesOptions {
  pathPrefix?: string;
}

export interface SearchFilterCondition {
  key: string;
  operator: "starts_with";
  value: string;
}

export interface SearchFilter {
  all?: SearchFilterCondition[];
}

export interface Store {
  listFiles(
    storeId: string,
    options?: ListFilesOptions,
  ): AsyncGenerator<StoreFile>;
  uploadFile(
    storeId: string,
    file: File | ReadableStream,
    options: UploadFileOptions,
  ): Promise<void>;
  deleteFile(storeId: string, externalId: string): Promise<void>;
  /** Ensures all search indices (FTS, vector) are up to date. Call once after bulk uploads. */
  ensureIndices(storeId: string): Promise<void>;
  search(
    storeIds: string[],
    query: string,
    top_k?: number,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<SearchResponse>;
  retrieve(storeId: string): Promise<unknown>;
  create(options: CreateStoreOptions): Promise<unknown>;
  ask(
    storeIds: string[],
    question: string,
    top_k?: number,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<AskResponse>;
  getInfo(storeId: string): Promise<StoreInfo>;
}

interface StoreMeta {
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  embedModel: string;
  embedDimensions: number;
  rerankModel: string;
  llmModel: string;
  maxChunkChars: number;
  maxChunkLines: number;
  overlapLines: number;
}

interface FileRow {
  external_id: string;
  path: string;
  hash: string;
  mtime: number;
}

interface ChunkRow {
  id: string;
  path: string;
  hash: string;
  mtime: number;
  chunk_index: number;
  text: string;
  vector: Float32Array;
  start_line: number;
  num_lines: number;
}

interface SearchRow extends Partial<ChunkRow> {
  _distance?: number;
  _score?: number;
}

interface ChunkDraft {
  id: string;
  chunk_index: number;
  text: string;
  start_line: number;
  num_lines: number;
}

function chunkText(
  externalId: string,
  content: string,
  maxChunkChars = MAX_CHUNK_CHARS,
  maxChunkLines = MAX_CHUNK_LINES,
  overlapLines = CHUNK_OVERLAP_LINES,
): ChunkDraft[] {
  const lines = content.split("\n");
  const chunks: ChunkDraft[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let charCount = 0;

    while (end < lines.length) {
      const nextLineLength = lines[end].length + 1;
      const nextLineCount = end - start + 1;
      if (
        end > start &&
        (charCount + nextLineLength > maxChunkChars ||
          nextLineCount > maxChunkLines)
      ) {
        break;
      }
      charCount += nextLineLength;
      end += 1;
    }

    if (end === start) {
      end += 1;
    }

    const text = lines.slice(start, end).join("\n").trim();
    if (text.length > 0) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: `${externalId}#${chunkIndex}`,
        chunk_index: chunkIndex,
        text,
        start_line: start,
        num_lines: end - start,
      });
    }

    if (end >= lines.length) {
      break;
    }

    // Dense long-line documents can produce chunks that are shorter than the
    // configured overlap. Clamp the next start so each iteration still
    // advances; otherwise we can keep re-chunking the same slice forever.
    start = Math.max(start + 1, end - overlapLines);
  }

  return chunks;
}

export const chunkTextForTesting = chunkText;

function candidateLimit(topK: number): number {
  return Math.max(MIN_CANDIDATES, topK * CANDIDATE_MULTIPLIER);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeLikeWildcards(value: string): string {
  return value.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function prefixPredicate(prefix?: string): string | undefined {
  if (!prefix) {
    return undefined;
  }
  return `path LIKE ${sqlString(`${escapeLikeWildcards(prefix)}%`)}`;
}

function scoreFromDistance(distance: number | undefined): number {
  if (distance === undefined) {
    return 0;
  }
  return 1 / (1 + Math.max(distance, 0));
}

function normalizeScores<T extends { score: number }>(items: T[]): T[] {
  if (items.length === 0) {
    return items;
  }
  const maxScore = Math.max(...items.map((item) => item.score), 0);
  if (maxScore <= 0) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    score: item.score / maxScore,
  }));
}

function extractPathPrefix(filters?: SearchFilter): string | undefined {
  const pathFilter = filters?.all?.find(
    (filter) => filter.key === "path" && filter.operator === "starts_with",
  );
  return pathFilter?.value;
}

function chunkRowToResult(row: SearchRow, score: number): ChunkType {
  return {
    type: "text",
    text: row.text ?? "",
    score,
    metadata: {
      path: row.path ?? "Unknown path",
      hash: row.hash ?? "",
      mtime: row.mtime,
    },
    chunk_index: row.chunk_index ?? 0,
    generated_metadata: {
      start_line: row.start_line ?? 0,
      num_lines: row.num_lines ?? 0,
    },
  };
}

function buildSourcesContext(sources: ChunkType[]): string {
  return sources
    .map((source, index) => {
      const start = source.generated_metadata.start_line + 1;
      const end = start + source.generated_metadata.num_lines - 1;
      return [
        `[${index}] ${source.metadata.path}:${start}-${end}`,
        source.text,
      ].join("\n");
    })
    .join("\n\n");
}

async function readText(file: File | ReadableStream): Promise<string> {
  if (
    "text" in file &&
    typeof (file as { text: unknown }).text === "function"
  ) {
    return await (file as File).text();
  }

  if ("getReader" in file) {
    const reader = (file as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }

  throw new Error("Unsupported upload type");
}

export class LanceStore implements Store {
  private connections = new Map<string, Promise<lancedb.Connection>>();
  private ftsVerified = new Set<string>();

  constructor(
    private config: MgrepConfig,
    private client: ModelStudioClient,
  ) {}

  private storeSlug(storeId: string): string {
    return encodeURIComponent(storeId);
  }

  private storePath(storeId: string): string {
    return path.join(this.config.lancedbPath, this.storeSlug(storeId));
  }

  private metaPath(storeId: string): string {
    return path.join(this.storePath(storeId), META_FILE);
  }

  private async ensureStoreDir(storeId: string): Promise<void> {
    await fs.mkdir(this.storePath(storeId), { recursive: true });
  }

  private async getConnection(storeId: string): Promise<lancedb.Connection> {
    const storePath = this.storePath(storeId);
    const existing = this.connections.get(storePath);
    if (existing) {
      return await existing;
    }

    const created = (async () => {
      await this.ensureStoreDir(storeId);
      return await lancedb.connect(storePath);
    })();
    this.connections.set(storePath, created);
    return await created;
  }

  private async hasTable(storeId: string, tableName: string): Promise<boolean> {
    const connection = await this.getConnection(storeId);
    const names = await connection.tableNames();
    return names.includes(tableName);
  }

  private async openTableIfExists(
    storeId: string,
    tableName: string,
  ): Promise<Table | null> {
    const exists = await this.hasTable(storeId, tableName);
    if (!exists) {
      return null;
    }

    const connection = await this.getConnection(storeId);
    return await connection.openTable(tableName);
  }

  private currentMeta(storeId: string, description = ""): StoreMeta {
    const now = new Date().toISOString();
    return {
      name: storeId,
      description,
      created_at: now,
      updated_at: now,
      embedModel: this.config.embedModel,
      embedDimensions: this.config.embedDimensions,
      rerankModel: this.config.rerankModel,
      llmModel: this.config.llmModel,
      maxChunkChars: MAX_CHUNK_CHARS,
      maxChunkLines: MAX_CHUNK_LINES,
      overlapLines: CHUNK_OVERLAP_LINES,
    };
  }

  private async loadMeta(storeId: string): Promise<StoreMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(storeId), "utf-8");
      return JSON.parse(raw) as StoreMeta;
    } catch {
      return null;
    }
  }

  private async saveMeta(meta: StoreMeta): Promise<void> {
    await this.ensureStoreDir(meta.name);
    await fs.writeFile(
      this.metaPath(meta.name),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8",
    );
  }

  private assertMetaCompatibility(meta: StoreMeta): void {
    if (
      meta.embedModel !== this.config.embedModel ||
      meta.embedDimensions !== this.config.embedDimensions ||
      meta.maxChunkChars !== MAX_CHUNK_CHARS ||
      meta.maxChunkLines !== MAX_CHUNK_LINES ||
      meta.overlapLines !== CHUNK_OVERLAP_LINES
    ) {
      throw new Error(
        `Store "${meta.name}" was built with incompatible embedding or chunking settings. Rebuild the local store after changing embed model, dimensions, or chunking configuration.`,
      );
    }
  }

  private async ensureMeta(
    storeId: string,
    description = "",
  ): Promise<StoreMeta> {
    const existing = await this.loadMeta(storeId);
    if (existing) {
      this.assertMetaCompatibility(existing);
      if (description && existing.description !== description) {
        const updated = {
          ...existing,
          description,
          updated_at: new Date().toISOString(),
        };
        await this.saveMeta(updated);
        return updated;
      }
      return existing;
    }

    const created = this.currentMeta(storeId, description);
    await this.saveMeta(created);
    return created;
  }

  private async ensureFilesTable(
    storeId: string,
    row: FileRow,
  ): Promise<Table> {
    const existing = await this.openTableIfExists(storeId, FILES_TABLE);
    if (existing) {
      return existing;
    }

    const connection = await this.getConnection(storeId);
    return await connection.createTable(FILES_TABLE, [
      row as unknown as Record<string, unknown>,
    ]);
  }

  private async ensureChunksTable(
    storeId: string,
    rows: ChunkRow[],
  ): Promise<Table> {
    const existing = await this.openTableIfExists(storeId, CHUNKS_TABLE);
    if (existing) {
      return existing;
    }

    this.ftsVerified.delete(storeId);
    const connection = await this.getConnection(storeId);
    return await connection.createTable(
      CHUNKS_TABLE,
      rows as unknown as Record<string, unknown>[],
    );
  }

  private async ensureChunkIndices(
    table: Table,
    storeId: string,
  ): Promise<void> {
    if (this.ftsVerified.has(storeId)) {
      return;
    }

    const indices = await table.listIndices();
    const hasFts = indices.some(
      (index: { indexType: string; columns: string[] }) =>
        index.indexType === "FTS" &&
        index.columns.length === 1 &&
        index.columns[0] === "text",
    );

    if (!hasFts) {
      await table.createIndex("text", {
        config: lancedb.Index.fts(),
        replace: true,
        waitTimeoutSeconds: 60,
      });
    }

    this.ftsVerified.add(storeId);
  }

  async *listFiles(
    storeId: string,
    options?: ListFilesOptions,
  ): AsyncGenerator<StoreFile> {
    const meta = await this.loadMeta(storeId);
    if (!meta) {
      return;
    }
    this.assertMetaCompatibility(meta);

    const table = await this.openTableIfExists(storeId, FILES_TABLE);
    if (!table) {
      return;
    }

    let query = table.query();
    if (options?.pathPrefix) {
      query = query.where(prefixPredicate(options.pathPrefix) as string);
    }

    const rows = (await query.toArray()) as FileRow[];
    for (const row of rows) {
      yield {
        external_id: row.external_id,
        metadata: {
          path: row.path,
          hash: row.hash,
          mtime: row.mtime,
        },
      };
    }
  }

  async uploadFile(
    storeId: string,
    file: File | ReadableStream,
    options: UploadFileOptions,
  ): Promise<void> {
    const metadata = options.metadata;
    if (!metadata) {
      throw new Error("Upload metadata is required");
    }

    await this.ensureMeta(storeId);
    const content = await readText(file);
    const chunks = chunkText(options.external_id, content);
    const vectors = await this.client.embed(chunks.map((chunk) => chunk.text));

    const fileRow: FileRow = {
      external_id: options.external_id,
      path: metadata.path,
      hash: metadata.hash,
      mtime: metadata.mtime ?? Date.now(),
    };

    const chunkRows: ChunkRow[] = chunks.map((chunk, index) => ({
      id: chunk.id,
      path: metadata.path,
      hash: metadata.hash,
      mtime: metadata.mtime ?? Date.now(),
      chunk_index: chunk.chunk_index,
      text: chunk.text,
      vector: vectors[index],
      start_line: chunk.start_line,
      num_lines: chunk.num_lines,
    }));

    const filesTable = await this.ensureFilesTable(storeId, fileRow);
    await filesTable.delete(`external_id = ${sqlString(options.external_id)}`);
    await filesTable.add([fileRow as unknown as Record<string, unknown>]);

    if (chunkRows.length === 0) {
      const chunksTable = await this.openTableIfExists(storeId, CHUNKS_TABLE);
      if (chunksTable) {
        await chunksTable.delete(`path = ${sqlString(metadata.path)}`);
      }
      return;
    }

    const chunksTable = await this.ensureChunksTable(storeId, chunkRows);
    await chunksTable.delete(`path = ${sqlString(metadata.path)}`);
    await chunksTable.add(chunkRows as unknown as Record<string, unknown>[]);
    if (!options.deferIndexing) {
      await this.ensureChunkIndices(chunksTable, storeId);
    }
  }

  async ensureIndices(storeId: string): Promise<void> {
    const chunksTable = await this.openTableIfExists(storeId, CHUNKS_TABLE);
    if (chunksTable) {
      await this.ensureChunkIndices(chunksTable, storeId);
    }
  }

  async deleteFile(storeId: string, externalId: string): Promise<void> {
    const filesTable = await this.openTableIfExists(storeId, FILES_TABLE);
    if (filesTable) {
      await filesTable.delete(`external_id = ${sqlString(externalId)}`);
    }

    const chunksTable = await this.openTableIfExists(storeId, CHUNKS_TABLE);
    if (chunksTable) {
      await chunksTable.delete(`path = ${sqlString(externalId)}`);
    }
  }

  private async searchStore(
    storeId: string,
    query: string,
    topK: number,
    searchOptions?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<ChunkType[]> {
    const meta = await this.loadMeta(storeId);
    if (!meta) {
      return [];
    }
    this.assertMetaCompatibility(meta);

    const table = await this.openTableIfExists(storeId, CHUNKS_TABLE);
    if (!table) {
      return [];
    }

    const limit = candidateLimit(topK);
    const predicate = prefixPredicate(extractPathPrefix(filters));
    const [queryVector] = await this.client.embed([query]);
    // LanceDB's vectorSearch API expects number[]; convert the single query
    // Float32Array (one vector, negligible cost) while stored chunk vectors
    // remain as Float32Array (off V8 heap).
    const queryVectorArray = Array.from(queryVector);

    let vectorQuery = table.vectorSearch(queryVectorArray).limit(limit);
    let ftsQuery = table.search(query, "fts", "text").limit(limit);
    if (predicate) {
      vectorQuery = vectorQuery.where(predicate);
      ftsQuery = ftsQuery.where(predicate);
    }

    const [vectorRows, ftsRows] = await Promise.all([
      vectorQuery.toArray() as Promise<SearchRow[]>,
      ftsQuery.toArray() as Promise<SearchRow[]>,
    ]);

    const fused = new Map<
      string,
      {
        row: SearchRow;
        score: number;
      }
    >();

    const addRanked = (rows: SearchRow[], key: "_distance" | "_score") => {
      for (const [index, row] of rows.entries()) {
        const rowId = row.id;
        if (!rowId) {
          continue;
        }
        const current = fused.get(rowId) ?? { row, score: 0 };
        const rankScore = 1 / (60 + index + 1);
        const localScore =
          key === "_distance"
            ? scoreFromDistance(row._distance)
            : Math.max(row._score ?? 0, 0);
        current.row = row;
        current.score += rankScore + localScore;
        fused.set(rowId, current);
      }
    };

    addRanked(vectorRows, "_distance");
    addRanked(ftsRows, "_score");

    let ranked = Array.from(fused.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RERANK_DOCUMENTS);

    if (searchOptions?.rerank !== false && ranked.length > 0) {
      const reranked = await this.client.rerank(
        query,
        ranked.map((item) => `${item.row.path}\n${item.row.text}`),
      );
      const next = reranked
        .map((item) => {
          const match = ranked[item.index];
          if (!match) {
            return null;
          }
          return {
            row: match.row,
            score: item.relevance_score,
          };
        })
        .filter(
          (item): item is { row: SearchRow; score: number } => item !== null,
        );
      ranked = next.length > 0 ? next : ranked;
    }

    return normalizeScores(ranked.slice(0, topK)).map((item) =>
      chunkRowToResult(item.row, item.score),
    );
  }

  private async runAgenticSearch(
    storeIds: string[],
    query: string,
    topK: number,
    searchOptions?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<ChunkType[]> {
    const plannedQueries = await this.client.planQueries(query);
    const combined = new Map<string, ChunkType>();

    for (const plannedQuery of plannedQueries) {
      const results = await this.search(
        storeIds,
        plannedQuery,
        topK,
        {
          ...searchOptions,
          agentic: false,
        },
        filters,
      );

      for (const result of results.data) {
        const key = `${result.metadata.path}:${result.chunk_index}`;
        const existing = combined.get(key);
        if (!existing || result.score > existing.score) {
          combined.set(key, result);
        }
      }
    }

    return Array.from(combined.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async search(
    storeIds: string[],
    query: string,
    top_k = DEFAULT_TOP_K,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<SearchResponse> {
    if (search_options?.agentic) {
      return {
        data: await this.runAgenticSearch(
          storeIds,
          query,
          top_k,
          search_options,
          filters,
        ),
      };
    }

    const allResults = await Promise.all(
      storeIds.map((storeId) =>
        this.searchStore(storeId, query, top_k, search_options, filters),
      ),
    );

    return {
      data: allResults
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, top_k),
    };
  }

  async retrieve(storeId: string): Promise<unknown> {
    const meta = await this.loadMeta(storeId);
    if (!meta) {
      throw new Error(`Store "${storeId}" does not exist`);
    }
    this.assertMetaCompatibility(meta);
    return meta;
  }

  async create(options: CreateStoreOptions): Promise<unknown> {
    const meta = await this.ensureMeta(options.name, options.description ?? "");
    return meta;
  }

  async ask(
    storeIds: string[],
    question: string,
    top_k = DEFAULT_TOP_K,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<AskResponse> {
    const sources = search_options?.agentic
      ? await this.runAgenticSearch(
          storeIds,
          question,
          top_k,
          search_options,
          filters,
        )
      : (await this.search(storeIds, question, top_k, search_options, filters))
          .data;

    const answer = await this.client.answer(
      question,
      buildSourcesContext(sources),
    );

    return {
      answer,
      sources,
    };
  }

  async getInfo(storeId: string): Promise<StoreInfo> {
    const meta = await this.ensureMeta(storeId);
    return {
      name: meta.name,
      description: meta.description,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      counts: {
        pending: 0,
        in_progress: 0,
      },
    };
  }
}

interface TestStoreDB {
  info: StoreInfo;
  files: Record<
    string,
    {
      metadata: FileMetadata;
      content: string;
    }
  >;
}

export class TestStore implements Store {
  path: string;
  private mutex: Promise<void> = Promise.resolve();

  constructor() {
    const path = process.env.MGREP_TEST_STORE_PATH;
    if (!path) {
      throw new Error("MGREP_TEST_STORE_PATH is not set");
    }
    this.path = path;
  }

  private async synchronized<T>(fn: () => Promise<T>): Promise<T> {
    let unlock: () => void = () => {};
    const newLock = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    const previousLock = this.mutex;
    this.mutex = newLock;

    await previousLock;

    try {
      return await fn();
    } finally {
      unlock();
    }
  }

  private async load(): Promise<TestStoreDB> {
    try {
      const content = await fs.readFile(this.path, "utf-8");
      return JSON.parse(content) as TestStoreDB;
    } catch {
      return {
        info: {
          name: "Test Store",
          description: "A test store",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          counts: { pending: 0, in_progress: 0 },
        },
        files: {},
      };
    }
  }

  private async save(data: TestStoreDB): Promise<void> {
    await fs.writeFile(this.path, JSON.stringify(data, null, 2));
  }

  private async readContent(file: File | ReadableStream): Promise<string> {
    return await readText(file);
  }

  async *listFiles(
    _storeId: string,
    options?: ListFilesOptions,
  ): AsyncGenerator<StoreFile> {
    const db = await this.load();
    for (const [external_id, file] of Object.entries(db.files)) {
      if (
        options?.pathPrefix &&
        file.metadata?.path &&
        !file.metadata.path.startsWith(options.pathPrefix)
      ) {
        continue;
      }
      yield {
        external_id,
        metadata: file.metadata,
      };
    }
  }

  async uploadFile(
    _storeId: string,
    file: File | ReadableStream,
    options: UploadFileOptions,
  ): Promise<void> {
    const content = await this.readContent(file);
    await this.synchronized(async () => {
      const db = await this.load();
      db.files[options.external_id] = {
        metadata: options.metadata || { path: options.external_id, hash: "" },
        content,
      };
      await this.save(db);
    });
  }

  async deleteFile(_storeId: string, externalId: string): Promise<void> {
    await this.synchronized(async () => {
      const db = await this.load();
      delete db.files[externalId];
      await this.save(db);
    });
  }

  async ensureIndices(_storeId: string): Promise<void> {}

  async search(
    _storeIds: string[],
    query: string,
    top_k = DEFAULT_TOP_K,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<SearchResponse> {
    const db = await this.load();
    const results: ChunkType[] = [];

    for (const file of Object.values(db.files)) {
      if (filters?.all) {
        const pathFilter = filters.all.find(
          (f) => f.key === "path" && f.operator === "starts_with",
        );
        if (
          pathFilter &&
          file.metadata &&
          !file.metadata.path.startsWith(pathFilter.value)
        ) {
          continue;
        }
      }

      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          const rerankSuffix = search_options?.rerank
            ? ""
            : " without reranking";
          const agenticSuffix = search_options?.agentic ? " with agentic" : "";
          results.push({
            type: "text",
            text: lines[i] + rerankSuffix + agenticSuffix,
            score: 1.0,
            metadata: file.metadata,
            chunk_index: results.length,
            generated_metadata: {
              start_line: i,
              num_lines: 1,
            },
          });
          if (results.length >= top_k) {
            break;
          }
        }
      }
      if (results.length >= top_k) {
        break;
      }
    }

    return { data: results };
  }

  async retrieve(_storeId: string): Promise<unknown> {
    const db = await this.load();
    return db.info;
  }

  async create(options: CreateStoreOptions): Promise<unknown> {
    return await this.synchronized(async () => {
      const db = await this.load();
      db.info.name = options.name;
      db.info.description = options.description || "";
      await this.save(db);
      return db.info;
    });
  }

  async ask(
    storeIds: string[],
    question: string,
    top_k?: number,
    search_options?: SearchOptions,
    filters?: SearchFilter,
  ): Promise<AskResponse> {
    const searchRes = await this.search(
      storeIds,
      question,
      top_k,
      search_options,
      filters,
    );
    return {
      answer: 'This is a mock answer from TestStore.<cite i="0" />',
      sources: searchRes.data,
    };
  }

  async getInfo(_storeId: string): Promise<StoreInfo> {
    const db = await this.load();
    return db.info;
  }
}
