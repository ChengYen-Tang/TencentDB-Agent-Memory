import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../config.js";

const ENV_NAMES = [
  "TDAI_TEST_INTERNAL_URL",
  "TDAI_TEST_INTERNAL_KEY",
  "TDAI_TEST_CODEX_URL",
  "TDAI_TEST_CODEX_KEY",
  "TDAI_TEST_GATEWAY_KEY",
  "TDAI_TEST_OPTIONAL_HOST",
] as const;

let tempDir = "";
const previousEnv = new Map<string, string | undefined>();

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
  for (const name of ENV_NAMES) {
    const value = previousEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnv.clear();
});

describe("MemoryProxy configuration", () => {
  it("expands environment variables for split internal and Codex upstreams", () => {
    for (const name of ENV_NAMES) previousEnv.set(name, process.env[name]);
    process.env.TDAI_TEST_INTERNAL_URL = "https://internal.example/v1";
    process.env.TDAI_TEST_INTERNAL_KEY = "internal-key";
    process.env.TDAI_TEST_CODEX_URL = "https://codex.example/v1";
    process.env.TDAI_TEST_CODEX_KEY = "codex-key";
    process.env.TDAI_TEST_GATEWAY_KEY = "gateway-key";
    delete process.env.TDAI_TEST_OPTIONAL_HOST;

    tempDir = mkdtempSync(path.join(tmpdir(), "memory-proxy-config-"));
    const configPath = path.join(tempDir, "config.yaml");
    writeFileSync(configPath, `
upstream:
  url: "\${TDAI_TEST_INTERNAL_URL}"
  apiKey: "\${TDAI_TEST_INTERNAL_KEY}"
  agents:
    codex:
      url: "\${TDAI_TEST_CODEX_URL}"
      apiKey: "\${TDAI_TEST_CODEX_KEY}"
auth:
  enabled: true
  url: "http://memory-core:8420"
  serviceToken: "\${TDAI_TEST_GATEWAY_KEY}"
langfuse:
  host: "\${TDAI_TEST_OPTIONAL_HOST:-https://langfuse.example}"
`, "utf8");

    const config = buildConfig({ configFile: configPath });

    expect(config.upstream).toEqual({
      url: "https://internal.example/v1",
      apiKey: "internal-key",
      agents: {
        codex: {
          url: "https://codex.example/v1",
          apiKey: "codex-key",
        },
      },
    });
    expect(config.auth.serviceToken).toBe("gateway-key");
    expect(config.langfuse.host).toBe("https://langfuse.example");
  });
});
