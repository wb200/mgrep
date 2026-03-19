import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { z } from "zod";
import {
  chunkToSearchHit,
  executeAnswer,
  executeSearch,
  executeSync,
} from "../lib/agent-service.js";
import { createStore } from "../lib/context.js";
import type { StoreInfo } from "../lib/store.js";
import { MaxFileCountExceededError } from "../lib/utils.js";
import { startWatch } from "./watch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const searchArgsSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  store: z.string().optional(),
  maxCount: z.number().int().positive().default(10),
  rerank: z.boolean().default(true),
  agentic: z.boolean().default(false),
});

const answerArgsSchema = z.object({
  question: z.string().min(1),
  path: z.string().optional(),
  store: z.string().optional(),
  maxCount: z.number().int().positive().default(10),
  rerank: z.boolean().default(true),
  agentic: z.boolean().default(false),
});

const syncArgsSchema = z.object({
  path: z.string().optional(),
  store: z.string().optional(),
  dryRun: z.boolean().default(false),
  maxFileSize: z.number().int().positive().optional(),
  maxFileCount: z.number().int().positive().optional(),
});

const statusArgsSchema = z.object({
  store: z.string().optional(),
});

function packageVersion(): string {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), {
      encoding: "utf-8",
    }),
  ).version;
}

function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function toolSuccess(
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof MaxFileCountExceededError) {
    return `${error.message} Increase the limit with --max-file-count or MGREP_MAX_FILE_COUNT.`;
  }

  return error instanceof Error ? error.message : String(error);
}

function redirectLogsToStderr(): void {
  console.log = (...args: unknown[]) => {
    process.stderr.write(`[LOG] ${args.join(" ")}\n`);
  };

  console.error = (...args: unknown[]) => {
    process.stderr.write(`[ERROR] ${args.join(" ")}\n`);
  };

  console.debug = (...args: unknown[]) => {
    process.stderr.write(`[DEBUG] ${args.join(" ")}\n`);
  };
}

function parseArguments<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
  toolName: string,
): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid arguments for tool "${toolName}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function loadStoreInfo(
  storeName: string,
): Promise<{ exists: boolean; info: StoreInfo | null }> {
  const store = await createStore();

  try {
    await store.retrieve(storeName);
  } catch {
    return {
      exists: false,
      info: null,
    };
  }

  return {
    exists: true,
    info: await store.getInfo(storeName),
  };
}

function toolDefinitions() {
  return [
    {
      name: "search",
      description: "Run a semantic local search against the indexed project.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "The semantic search query." },
          path: {
            type: "string",
            description: "Optional absolute or relative path scope.",
          },
          store: {
            type: "string",
            description: "Logical store name to search.",
          },
          maxCount: {
            type: "number",
            description: "Maximum number of hits to return.",
            default: 10,
          },
          rerank: {
            type: "boolean",
            description: "Whether reranking should be enabled.",
            default: true,
          },
          agentic: {
            type: "boolean",
            description: "Whether agentic query planning should be enabled.",
            default: false,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "answer",
      description:
        "Answer a question from the indexed project and return structured sources.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", description: "The question to answer." },
          path: {
            type: "string",
            description: "Optional absolute or relative path scope.",
          },
          store: {
            type: "string",
            description: "Logical store name to search.",
          },
          maxCount: {
            type: "number",
            description: "Maximum number of source chunks to use.",
            default: 10,
          },
          rerank: {
            type: "boolean",
            description: "Whether reranking should be enabled.",
            default: true,
          },
          agentic: {
            type: "boolean",
            description: "Whether agentic query planning should be enabled.",
            default: false,
          },
        },
        required: ["question"],
      },
    },
    {
      name: "sync",
      description:
        "Run a one-shot sync of the current project or a scoped subpath into the local store.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Optional absolute or relative path scope to sync.",
          },
          store: {
            type: "string",
            description: "Logical store name to sync.",
          },
          dryRun: {
            type: "boolean",
            description: "If true, calculate sync changes without uploading.",
            default: false,
          },
          maxFileSize: {
            type: "number",
            description: "Maximum file size in bytes to upload.",
          },
          maxFileCount: {
            type: "number",
            description: "Maximum number of files allowed in the sync.",
          },
        },
      },
    },
    {
      name: "status",
      description:
        "Inspect whether a store exists and return its current metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          store: {
            type: "string",
            description: "Logical store name to inspect.",
          },
        },
      },
    },
  ];
}

async function handleToolCall(
  options: { cwd: string; defaultStore: string },
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  try {
    if (name === "search") {
      const parsed = parseArguments(searchArgsSchema, args, name);
      const storeName = parsed.store ?? options.defaultStore;
      const store = await createStore();
      const result = await executeSearch(store, options.cwd, {
        store: storeName,
        path: parsed.path,
        query: parsed.query,
        maxCount: parsed.maxCount,
        rerank: parsed.rerank,
        agentic: parsed.agentic,
      });

      return toolSuccess({
        store: storeName,
        scopedPath: result.scopedPath,
        hits: result.response.data.map(chunkToSearchHit),
      });
    }

    if (name === "answer") {
      const parsed = parseArguments(answerArgsSchema, args, name);
      const storeName = parsed.store ?? options.defaultStore;
      const store = await createStore();
      const result = await executeAnswer(store, options.cwd, {
        store: storeName,
        path: parsed.path,
        query: parsed.question,
        maxCount: parsed.maxCount,
        rerank: parsed.rerank,
        agentic: parsed.agentic,
      });

      return toolSuccess({
        store: storeName,
        scopedPath: result.scopedPath,
        answer: result.response.answer,
        sources: result.response.sources.map(chunkToSearchHit),
      });
    }

    if (name === "sync") {
      const parsed = parseArguments(syncArgsSchema, args, name);
      const storeName = parsed.store ?? options.defaultStore;
      const store = await createStore();
      const result = await executeSync(store, options.cwd, {
        store: storeName,
        path: parsed.path,
        dryRun: parsed.dryRun,
        maxFileSize: parsed.maxFileSize,
        maxFileCount: parsed.maxFileCount,
      });

      return toolSuccess({
        store: storeName,
        root: result.root,
        dryRun: parsed.dryRun,
        processed: result.result.processed,
        uploaded: result.result.uploaded,
        deleted: result.result.deleted,
        errors: result.result.errors,
        total: result.result.total,
      });
    }

    if (name === "status") {
      const parsed = parseArguments(statusArgsSchema, args, name);
      const storeName = parsed.store ?? options.defaultStore;
      const status = await loadStoreInfo(storeName);

      return toolSuccess({
        cwd: options.cwd,
        store: storeName,
        exists: status.exists,
        info: status.info,
      });
    }

    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    return toolError(errorMessage(error));
  }
}

export function createMgrepMcpServer(options: {
  cwd: string;
  defaultStore: string;
}): Server {
  const server = new Server(
    {
      name: "mgrep",
      version: packageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await handleToolCall(
      options,
      request.params.name,
      request.params.arguments,
    );
  });

  return server;
}

async function startBackgroundSync(store: string): Promise<void> {
  console.log("[SYNC] Scheduling initial sync in 1 second...");

  setTimeout(async () => {
    console.log("[SYNC] Starting file sync...");
    try {
      await startWatch({ store, dryRun: false });
    } catch (error) {
      console.error("[SYNC] Sync failed:", errorMessage(error));
    }
  }, 1000);
}

export const watchMcp = new Command("mcp")
  .description("Start MCP server for mgrep")
  .action(async (_options, cmd) => {
    process.on("SIGINT", () => {
      console.error("Received SIGINT, shutting down gracefully...");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.error("Received SIGTERM, shutting down gracefully...");
      process.exit(0);
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error(
        "[ERROR] Unhandled Rejection at:",
        promise,
        "reason:",
        reason,
      );
    });

    redirectLogsToStderr();

    const options: {
      store: string;
    } = cmd.optsWithGlobals();

    const transport = new StdioServerTransport();
    const server = createMgrepMcpServer({
      cwd: process.cwd(),
      defaultStore: options.store,
    });

    await server.connect(transport);
    await startBackgroundSync(options.store);
  });
