import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { parseLlmReasoningEffort } from "./llm-reasoning.js";

describe("parseLlmReasoningEffort", () => {
  it("normalizes supported values", () => {
    expect(parseLlmReasoningEffort(" HIGH ", "llm.reasoningEffort")).toBe("high");
    expect(parseLlmReasoningEffort("max", "llm.reasoningEffort")).toBe("max");
  });

  it("treats an empty value as unset", () => {
    expect(parseLlmReasoningEffort("", "llm.reasoningEffort")).toBeUndefined();
  });

  it("rejects unsupported values before a model call", () => {
    expect(() => parseLlmReasoningEffort("maximum", "llm.reasoningEffort"))
      .toThrow("llm.reasoningEffort must be one of");
  });

  it("uses the setting from standalone MemoryCore config", () => {
    expect(parseConfig({
      llm: { reasoningEffort: "minimal" },
    }).llm.reasoningEffort).toBe("minimal");
  });
});
