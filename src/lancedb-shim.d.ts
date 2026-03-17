declare module "@lancedb/lancedb" {
  export interface IndexInfo {
    name: string;
    indexType: string;
    columns: string[];
  }

  export interface Query {
    where(predicate: string): Query;
    limit(limit: number): Query;
    toArray(): Promise<unknown[]>;
  }

  export interface Table {
    listIndices(): Promise<IndexInfo[]>;
    createIndex(
      column: string,
      options?: {
        config?: unknown;
        replace?: boolean;
        waitTimeoutSeconds?: number;
      },
    ): Promise<void>;
    query(): Query;
    search(
      query: string,
      queryType?: string,
      ftsColumns?: string | string[],
    ): Query;
    vectorSearch(vector: number[]): Query;
    delete(predicate: string): Promise<unknown>;
    add(data: Record<string, unknown>[]): Promise<unknown>;
  }

  export interface Connection {
    tableNames(): Promise<string[]>;
    openTable(name: string): Promise<Table>;
    createTable(name: string, data: Record<string, unknown>[]): Promise<Table>;
  }

  export const Index: {
    fts(options?: unknown): unknown;
  };

  export function connect(uri: string): Promise<Connection>;
}
