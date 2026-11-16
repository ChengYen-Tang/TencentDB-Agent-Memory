/** Optional dense Wiki retrieval using an OpenAI-compatible embeddings endpoint. */
import { createHash } from "node:crypto";
import type { WikiPage, SearchResponse, SearchResult } from "./types.js";
import { withWriteDb } from "./index-db.js";

export type WikiSearchMode = "bm25" | "vector" | "hybrid";

export function searchMode(value: unknown): WikiSearchMode | undefined {
  return value === "bm25" || value === "vector" || value === "hybrid" ? value : undefined;
}

export function defaultSearchMode(): WikiSearchMode {
  const value = process.env.KNOWLEDGE_WIKI_SEARCH_MODE?.trim() || "bm25";
  const mode = searchMode(value);
  if (!mode) throw new Error("KNOWLEDGE_WIKI_SEARCH_MODE must be bm25, vector or hybrid");
  return mode;
}

type Chunk = { key: string; page: WikiPage; text: string; hash: string; vector?: number[] };
const locks = new Map<string, Promise<void>>();

async function embeddings(input: string[], model: string, baseUrl: string, apiKey: string): Promise<number[][]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}`);
  const json = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  if (!Array.isArray(json.data) || json.data.length !== input.length) throw new Error("Embedding service returned an invalid result count");
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((item, index) => {
    if (item.index !== index || !Array.isArray(item.embedding) || !item.embedding.length || !item.embedding.every(Number.isFinite)) {
      throw new Error("Embedding service returned an invalid vector");
    }
    return item.embedding;
  });
  if (vectors.some((vector) => vector.length !== vectors[0].length)) throw new Error("Embedding dimensions differ within a batch");
  return vectors;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimensions differ; rebuild the vector index");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Builds/updates vectors lazily. index.db stays inside the wiki's persistent directory. */
export async function vectorSearch(wikiDir: string, pages: WikiPage[], query: string, limit: number): Promise<SearchResponse> {
  const baseUrl = process.env.KNOWLEDGE_EMBEDDING_BASE_URL?.trim();
  const model = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  if (!baseUrl || !model) throw new Error("Set KNOWLEDGE_EMBEDDING_BASE_URL and KNOWLEDGE_EMBEDDING_MODEL to use vector search");
  const apiKey = process.env.KNOWLEDGE_EMBEDDING_API_KEY?.trim() || "";
  const identity = createHash("sha256").update(`${baseUrl}\0${model}`).digest("hex");
  const chunks: Chunk[] = [];
  for (const page of pages.filter((p) => p.type !== "query")) {
    const text = `${page.title}\n${page.content}`;
    for (let offset = 0, part = 0; offset < text.length; offset += 1500, part++) {
      const content = text.slice(offset, offset + 1800);
      chunks.push({ key: `${page.id}\0${part}`, page, text: content, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
  const previous = locks.get(wikiDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(wikiDir, current);
  await previous;
  try {
    const cached = withWriteDb(wikiDir, (db) => {
      db.exec("CREATE TABLE IF NOT EXISTS wiki_vectors (chunk_key TEXT PRIMARY KEY, hash TEXT NOT NULL, model_key TEXT NOT NULL, vector TEXT NOT NULL)");
      return db.prepare("SELECT chunk_key, hash, model_key, vector FROM wiki_vectors").all() as Array<{ chunk_key: string; hash: string; model_key: string; vector: string }>;
    });
    const byKey = new Map(cached.map((row) => [row.chunk_key, row]));
    const missing: Chunk[] = [];
    for (const chunk of chunks) {
      const row = byKey.get(chunk.key);
      if (row && row.hash === chunk.hash && row.model_key === identity) {
        try { const value: unknown = JSON.parse(row.vector); if (Array.isArray(value) && value.length && value.every(Number.isFinite)) chunk.vector = value; } catch { /* regenerate */ }
      }
      if (!chunk.vector) missing.push(chunk);
    }
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const vectors = await embeddings(batch.map((chunk) => chunk.text), model, baseUrl, apiKey);
      withWriteDb(wikiDir, (db) => {
        const put = db.prepare("INSERT OR REPLACE INTO wiki_vectors (chunk_key, hash, model_key, vector) VALUES (?, ?, ?, ?)");
        batch.forEach((chunk, n) => { chunk.vector = vectors[n]; put.run(chunk.key, chunk.hash, identity, JSON.stringify(vectors[n])); });
      });
    }
    const [queryVector] = await embeddings([query], model, baseUrl, apiKey);
    const best = new Map<string, SearchResult>();
    for (const chunk of chunks) {
      const score = cosine(queryVector, chunk.vector!);
      const old = best.get(chunk.page.id);
      if (!old || score > old.score) best.set(chunk.page.id, { path: chunk.page.relPath, title: chunk.page.title, type: chunk.page.type, snippet: chunk.text.slice(0, 300), score, hop: 0 });
    }
    const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return { results, links: [], count: results.length };
  } finally {
    release();
    if (locks.get(wikiDir) === current) locks.delete(wikiDir);
  }
}

/** Reciprocal rank fusion keeps BM25 and cosine scores on independent scales. */
export function fuseSearch(bm25: SearchResponse, vector: SearchResponse, limit: number): SearchResponse {
  const merged = new Map<string, SearchResult>();
  for (const list of [bm25.results, vector.results]) list.forEach((item, rank) => {
    const old = merged.get(item.path);
    merged.set(item.path, { ...(old ?? item), score: (old?.score ?? 0) + 1 / (60 + rank + 1) });
  });
  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const paths = new Set(results.map((result) => result.path));
  return { results, links: bm25.links.filter((link) => paths.has(link.source) && paths.has(link.target)), count: results.length };
}
