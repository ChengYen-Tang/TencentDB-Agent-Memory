/**
 * Reasoning-effort values accepted by the OpenAI Chat Completions provider in
 * the AI SDK version used by MemoryCore. Whether a particular value is
 * accepted remains model-dependent at the upstream API.
 */
export const LLM_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

/**
 * Normalize an optional config value and reject typos before a background
 * memory job reaches the upstream model.
 */
export function parseLlmReasoningEffort(
  value: string | undefined,
  settingName: string,
): LlmReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;

  if ((LLM_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as LlmReasoningEffort;
  }

  throw new Error(
    `${settingName} must be one of: ${LLM_REASONING_EFFORTS.join(", ")}. ` +
      `Support is model-dependent.`,
  );
}
