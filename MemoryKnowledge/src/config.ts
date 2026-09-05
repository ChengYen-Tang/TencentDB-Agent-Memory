/**
 * Service configuration — environment variables + config loading.
 *
 * .env is auto-loaded via dotenv on import of this module.
 * All config is loaded from env vars with sensible defaults.
 * LLM config can also be passed explicitly to createKnowledgeModule.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import 'dotenv/config';
import { parse as parseYaml } from "yaml";

/** Expand leading ~/ to the user's home directory. */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return `${homedir()}${filepath.slice(1)}`;
  }
  return filepath;
}

export interface LlmConfig {
  /**
   * Global default routing when NO per-instance llm_binding exists:
   *   - 'proxy' (default): wiki ingest must go through context_proxy via a
   *     TMC-pushed binding. No silent direct fallback — if a binding is missing,
   *     ingest fails loudly (see resolveLlmConfig / createLlmClient).
   *   - 'custom': use the global baseUrl/apiKey below to call an OpenAI-compatible
   *     endpoint directly (BYO).
   * Per-instance bindings always override this default.
   */
  mode: "proxy" | "custom";
  /** LLM 协议：openai 走 /chat/completions，anthropic 走 /messages。默认 openai（向后兼容）。 */
  protocol: "openai" | "anthropic";
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  /**
   * Optional reasoning budget for supported OpenAI-compatible models.
   * Passed to Wiki ingestion calls as `reasoning_effort`.
   */
  reasoningEffort?: LlmReasoningEffort;
  /** LLM request timeout in ms. Defaults to 1200000 (20min) — reasoning 模型需要更长时间。 */
  timeoutMs: number;
  /**
   * 是否用流式请求(streamText)调用上游。默认 false(非流式)。
   * 个别只接受流式请求的兼容上游需置 true。per-instance binding 不覆盖此字段(部署级开关)。
   */
  stream?: boolean;
}

/** Reasoning effort values supported by the OpenAI-compatible Wiki client. */
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

function parseLlmReasoningEffort(value: string | undefined): LlmReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((LLM_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as LlmReasoningEffort;
  }
  throw new Error(
    `LLM_REASONING_EFFORT must be one of: ${LLM_REASONING_EFFORTS.join(", ")}. ` +
    "Support is model-dependent.",
  );
}

export interface ClickHouseTelemetryConfig {
  enabled: boolean;
  url: string;
  database: string;
  table: string;
  user: string;
  password: string;
  flushIntervalMs: number;
  flushThreshold: number;
  ttlDays: number;
  requestTimeoutMs: number;
}

export interface ServiceConfig {
  /** HTTP server port. */
  port: number;
  /** Data root directory for knowledge assets (git clones, wiki dirs, SQLite). */
  dataDir: string;
  /** SQLite database file path. */
  dbPath: string;
  /** LLM configuration for wiki ingest. */
  llm: LlmConfig;
  /** Log level. */
  logLevel: string;
  /** API route prefix (default: /v3). */
  apiPrefix: string;
  /** Public base URL for service_url generation (e.g. http://10.2.3.4:8421). */
  publicBaseUrl: string;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl: string;
  /** Optional ClickHouse request telemetry. Disabled by default. */
  clickhouse: ClickHouseTelemetryConfig;
}

function env(key: string, fallback: string): string {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Read llm.maxTokens from the Gateway YAML mounted by the root Compose file. */
function sharedGatewayMaxTokens(): number | undefined {
  const configPath = process.env.TDAI_SHARED_LLM_CONFIG?.trim();
  if (!configPath) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read TDAI_SHARED_LLM_CONFIG at ${configPath}: ${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`TDAI_SHARED_LLM_CONFIG at ${configPath} must contain a YAML object`);
  }

  const llm = (parsed as Record<string, unknown>).llm;
  const maxTokens = llm && typeof llm === "object" && !Array.isArray(llm)
    ? (llm as Record<string, unknown>).maxTokens
    : undefined;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(`TDAI_SHARED_LLM_CONFIG at ${configPath} must set llm.maxTokens to a positive number`);
  }
  return maxTokens;
}

function resolvedLlmMaxTokens(): number {
  // Keep the standalone service's explicit LLM_MAX_TOKENS override intact.
  // The root Compose deployment leaves it unset so both services share YAML.
  if (process.env.LLM_MAX_TOKENS) return envInt("LLM_MAX_TOKENS", 32768);
  return sharedGatewayMaxTokens() ?? 32768;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * 单 wiki 内阶段1 并发 LLM 抽取数。
 * KNOWLEDGE_WIKI_INGEST_CONCURRENCY，默认 3，clamp 1~10。
 */
export function getIngestConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY ?? "", 10);
  return clamp(Number.isNaN(raw) ? 3 : raw, 1, 10);
}

/**
 * 全局 LLM 最大并发数（跨所有 wiki 的 extract + merge）。
 * KNOWLEDGE_LLM_GLOBAL_CONCURRENCY，默认 5，clamp 1~20。
 */
export function getGlobalLlmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY ?? "", 10);
  return clamp(Number.isNaN(raw) ? 5 : raw, 1, 20);
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}

function validateClickHouseConfig(config: ClickHouseTelemetryConfig): void {
  if (!config.enabled) return;
  if (!config.url) throw new Error("KNOWLEDGE_CLICKHOUSE_URL is required when telemetry is enabled");
  const url = new URL(config.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("KNOWLEDGE_CLICKHOUSE_URL must use http or https");
  }
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!identifier.test(config.database)) throw new Error("Invalid KNOWLEDGE_CLICKHOUSE_DATABASE");
  if (!identifier.test(config.table)) throw new Error("Invalid KNOWLEDGE_CLICKHOUSE_TABLE");
  if (config.flushIntervalMs < 100) throw new Error("KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS must be >= 100");
  if (config.flushThreshold < 1) throw new Error("KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD must be >= 1");
  if (config.ttlDays < 0) throw new Error("KNOWLEDGE_CLICKHOUSE_TTL_DAYS must be >= 0");
  if (config.requestTimeoutMs < 100) throw new Error("KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS must be >= 100");
}

/**
 * Load service configuration from environment variables.
 */
export function loadConfig(): ServiceConfig {
  const clickhouse: ClickHouseTelemetryConfig = {
    enabled: envBool("KNOWLEDGE_CLICKHOUSE_ENABLED", false),
    url: env("KNOWLEDGE_CLICKHOUSE_URL", ""),
    database: env("KNOWLEDGE_CLICKHOUSE_DATABASE", "default"),
    table: env("KNOWLEDGE_CLICKHOUSE_TABLE", "tool_call_logs"),
    user: env("KNOWLEDGE_CLICKHOUSE_USER", "default"),
    password: env("KNOWLEDGE_CLICKHOUSE_PASSWORD", ""),
    flushIntervalMs: envInt("KNOWLEDGE_CLICKHOUSE_FLUSH_INTERVAL_MS", 5000),
    flushThreshold: envInt("KNOWLEDGE_CLICKHOUSE_FLUSH_THRESHOLD", 50),
    ttlDays: envInt("KNOWLEDGE_CLICKHOUSE_TTL_DAYS", 90),
    requestTimeoutMs: envInt("KNOWLEDGE_CLICKHOUSE_REQUEST_TIMEOUT_MS", 5000),
  };
  validateClickHouseConfig(clickhouse);

  return {
    port: envInt("PORT", 8421),
    dataDir: expandHome(env("KNOWLEDGE_DATA_DIR", "./data")),
    dbPath: expandHome(env("KNOWLEDGE_DB_PATH", "./data/knowledge.db")),
    logLevel: env("LOG_LEVEL", "debug"),
    apiPrefix: env("API_PREFIX", "/v3"),
    publicBaseUrl: env("KNOWLEDGE_PUBLIC_BASE_URL", ""),
    tmcCallbackUrl: env("TMC_CALLBACK_URL", ""),
    clickhouse,
    llm: {
      mode: env("LLM_MODE", "proxy") === "custom" ? "custom" : "proxy",
      protocol: env("LLM_PROTOCOL", "openai") === "anthropic" ? "anthropic" : "openai",
      provider: env("LLM_PROVIDER", "custom"),
      apiKey: env("LLM_API_KEY", ""),
      model: env("LLM_MODEL", "Memory-Model"),
      baseUrl: env("LLM_BASE_URL", ""),
      maxTokens: resolvedLlmMaxTokens(),
      reasoningEffort: parseLlmReasoningEffort(env("LLM_REASONING_EFFORT", "")),
      timeoutMs: envInt("LLM_TIMEOUT_MS", 1200000),
      stream: process.env.LLM_STREAM === "true",
    },
  };
}
