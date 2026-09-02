import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StandaloneLLMRunner } from "./llm-runner.js";

describe("StandaloneLLMRunner", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    server = undefined;
  });

  it("forwards configured reasoning effort to Chat Completions", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server = createServer((req, res) => {
      let rawBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      req.on("end", () => {
        requestBody = JSON.parse(rawBody) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "gpt-5",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        model: "gpt-5",
        reasoningEffort: "high",
      },
    });

    await expect(runner.run({ prompt: "test", taskId: "reasoning-effort-test" }))
      .resolves.toBe("done");
    expect(requestBody).toMatchObject({
      model: "gpt-5",
      reasoning_effort: "high",
    });
  });
});
