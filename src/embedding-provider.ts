import { config } from "./config.js";
import { embedText } from "./embeddings.js";

export type EmbeddingProvider = {
  modelId: string;
  embedMany(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
};

export class HashEmbeddingProvider implements EmbeddingProvider {
  modelId = "hash-128";
  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedText(t));
  }
  async embedOne(text: string): Promise<number[]> {
    return embedText(text);
  }
}

export class DeepSeekEmbeddingProvider implements EmbeddingProvider {
  modelId: string;
  private readonly endpoints = ["https://api.deepseek.com/v1/embeddings", "https://api.deepseek.com/embeddings"];

  constructor(model = process.env.DEEPSEEK_EMBEDDING_MODEL?.trim() || "deepseek-embedding") {
    this.modelId = model;
  }

  private async callOpenAICompat(endpoint: string, input: string | string[]): Promise<number[][]> {
    if (!config.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY 未配置");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llmTimeoutMs);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.deepseekApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: this.modelId, input }),
      signal: ac.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embeddings ${endpoint} HTTP ${res.status}: ${body}`);
    }

    const payload = (await res.json()) as any;
    const data = Array.isArray(payload?.data) ? payload.data : [];
    if (data.length === 0) throw new Error(`Embeddings ${endpoint} 返回空 data`);

    const vectors = data
      .map((d: any) => (Array.isArray(d?.embedding) ? d.embedding.map((x: unknown) => Number(x)) : null))
      .filter((v: number[] | null): v is number[] => Array.isArray(v));

    if (vectors.length === 0) throw new Error(`Embeddings ${endpoint} 返回结构异常`);
    return vectors;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let lastErr: unknown;
    for (const ep of this.endpoints) {
      try {
        const batched = await this.callOpenAICompat(ep, texts);
        if (batched.length === texts.length) return batched;
        // 某些网关返回长度不一致，降级逐条
        const out: number[][] = [];
        for (const t of texts) {
          const one = await this.callOpenAICompat(ep, t);
          out.push(one[0]);
        }
        return out;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("DeepSeek embeddings 调用失败");
  }

  async embedOne(text: string): Promise<number[]> {
    const arr = await this.embedMany([text]);
    return arr[0];
  }
}

export const buildEmbeddingProvider = (): EmbeddingProvider => {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "deepseek").trim().toLowerCase();
  if (provider === "hash") return new HashEmbeddingProvider();
  return new DeepSeekEmbeddingProvider();
};
