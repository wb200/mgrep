import OpenAI from "openai";

const DEEPINFRA_OPENAI_BASE_URL = "https://api.deepinfra.com/v1/openai";
const DEEPINFRA_INFERENCE_BASE_URL = "https://api.deepinfra.com/v1/inference";

const EMBEDDING_BATCH_SIZE = 10;
const DEFAULT_EMBED_DIMENSIONS = 2560;
const API_TIMEOUT_MS = 60_000;

export interface ModelStudioConfig {
  deepinfraApiKey: string;
  embedModel: string;
  embedDimensions: number;
  rerankModel: string;
  llmModel: string;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

interface DeepInfraRerankResponse {
  scores?: number[];
}

export function getDeepInfraApiKey(): string | undefined {
  return process.env.DEEPINFRA_API_KEY;
}

export function createModelStudioConfig(options: {
  embedModel: string;
  embedDimensions?: number;
  rerankModel: string;
  llmModel: string;
}): ModelStudioConfig {
  const deepinfraApiKey = getDeepInfraApiKey();
  if (!deepinfraApiKey) {
    throw new Error(
      "DEEPINFRA_API_KEY is not set. Export a DeepInfra API key for embeddings, rerank, answers, and agentic planning before using mgrep.",
    );
  }

  return {
    deepinfraApiKey,
    embedModel: options.embedModel,
    embedDimensions: options.embedDimensions ?? DEFAULT_EMBED_DIMENSIONS,
    rerankModel: options.rerankModel,
    llmModel: options.llmModel,
  };
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[]);
  }
  return chunks;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const withoutStart = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  return withoutStart.replace(/\s*```$/, "").trim();
}

export class ModelStudioClient {
  private deepinfraClient: OpenAI;
  private config: ModelStudioConfig;

  constructor(config: ModelStudioConfig) {
    this.config = config;
    this.deepinfraClient = new OpenAI({
      apiKey: config.deepinfraApiKey,
      baseURL: DEEPINFRA_OPENAI_BASE_URL,
    });
  }

  get embedModel(): string {
    return this.config.embedModel;
  }

  get embedDimensions(): number {
    return this.config.embedDimensions;
  }

  get rerankModel(): string {
    return this.config.rerankModel;
  }

  get llmModel(): string {
    return this.config.llmModel;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const vectors: number[][] = [];
    for (const batch of chunkArray(texts, EMBEDDING_BATCH_SIZE)) {
      const response = await this.deepinfraClient.embeddings.create(
        {
          model: this.config.embedModel,
          input: batch,
          encoding_format: "float",
          dimensions: this.config.embedDimensions,
        },
        { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
      );
      for (const item of response.data) {
        vectors.push(item.embedding);
      }
    }

    return vectors;
  }

  async rerank(
    query: string,
    documents: readonly string[],
  ): Promise<RerankResult[]> {
    if (documents.length === 0) {
      return [];
    }

    const response = await fetch(
      `${DEEPINFRA_INFERENCE_BASE_URL}/${encodeURIComponent(this.config.rerankModel)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.deepinfraApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          queries: [query],
          documents,
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Rerank request failed: ${message}`);
    }

    const data = (await response.json()) as DeepInfraRerankResponse;
    return (data.scores ?? []).map((score, index) => ({
      index,
      relevance_score: score,
    }));
  }

  async respond(options: {
    instructions: string;
    input: string;
  }): Promise<{ text: string; reasoning: string[] }> {
    const response = await this.deepinfraClient.chat.completions.create(
      {
        model: this.config.llmModel,
        messages: [
          { role: "system", content: options.instructions },
          { role: "user", content: options.input },
        ],
      },
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );

    const text = response.choices[0]?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("DeepInfra chat completions returned an empty response");
    }

    return {
      text: text.trim(),
      reasoning: [],
    };
  }

  async planQueries(question: string, maxQueries = 4): Promise<string[]> {
    const instructions = [
      "You are generating semantic code-search subqueries.",
      `Return ONLY a JSON array of 1-${maxQueries} short search queries.`,
      "Do not include markdown, prose, or explanations.",
      "Preserve concrete identifiers from the user question when useful.",
      "Prefer complementary subqueries over paraphrasing the same one.",
    ].join(" ");

    const { text } = await this.respond({
      instructions,
      input: question,
    });

    try {
      const parsed = JSON.parse(stripCodeFence(text));
      if (!Array.isArray(parsed)) {
        return [question];
      }
      const queries = parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, maxQueries);
      return queries.length > 0 ? queries : [question];
    } catch {
      return [question];
    }
  }

  async answer(question: string, context: string): Promise<string> {
    const instructions = [
      "Answer only from the provided sources.",
      "If the sources are insufficient, say so directly.",
      'Use citation tags in the exact format <cite i="N" /> where N is the source index.',
      "Do not invent citations.",
      "Prefer concise, factual answers.",
    ].join(" ");

    const input = `Question:\n${question}\n\nSources:\n${context}`;
    const { text } = await this.respond({
      instructions,
      input,
    });
    return text;
  }

  async validate(): Promise<void> {
    await this.embed(["mgrep configuration check"]);
    await this.rerank("mgrep configuration check", [
      "mgrep configuration check",
    ]);
    await this.respond({
      instructions: 'Reply with exactly "OK".',
      input: "Check the DeepInfra chat completions configuration.",
    });
  }
}
