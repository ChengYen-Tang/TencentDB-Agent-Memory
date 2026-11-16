import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initIndexDb } from "./index-db.js";
import { fuseSearch, vectorSearch } from "./vector-search.js";
import type { WikiPage } from "./types.js";

const dirs: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("wiki vector search", () => {
  it("ranks pages by cosine similarity and reuses cached document vectors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-vector-test-"));
    dirs.push(dir);
    initIndexDb(dir);
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "http://embedding.test/v1";
    process.env.KNOWLEDGE_EMBEDDING_MODEL = "test-model";
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const { input } = JSON.parse(options.body as string) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: text.includes("apple") ? [1, 0] : [0, 1] })) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = (id: string): WikiPage => ({ id, title: id, type: "concept", path: id, relPath: `wiki/${id}.md`, content: id, sources: [], links: [] });
    const pages = [page("apple"), page("orange")];
    expect((await vectorSearch(dir, pages, "apple", 2)).results[0].title).toBe("apple");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vectorSearch(dir, pages, "orange", 2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pages[0].content = "changed apple";
    await vectorSearch(dir, pages, "apple", 2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fuses ranked lists without mixing their score scales", () => {
    const result = (path: string, score: number) => ({ path, score, title: path, snippet: "", type: "concept" });
    const bm25 = { results: [result("a", 100), result("b", 1)], links: [], count: 2 };
    const vector = { results: [result("b", 0.9), result("c", 0.8)], links: [], count: 2 };
    expect(fuseSearch(bm25, vector, 3).results.map((item) => item.path)).toEqual(["b", "a", "c"]);
  });
});
