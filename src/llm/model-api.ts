// Raw HTTP client for the model API. The only code in the repository that calls a model.
//
// Why raw: the point of this repository is to show what a harness does. An SDK hides the
// request body, the retry policy, and the shape of tool calls. Here every byte that goes to
// the model is a plain object you can print. No SDK, no framework, just fetch.
//
// The harness speaks one message format throughout: the Anthropic Messages API's (content
// blocks, tool_use, tool_result). MODEL_PROVIDER picks where requests go:
//   anthropic          (default) the Anthropic API, or any gateway that speaks its format
//   openai-compatible  any /v1/chat/completions server: OpenAI, Ollama, vLLM, LM Studio...
//                      translated by openai-compatible.ts, so nothing else changes

import { estimateTokens, fromChatResponse, toChatRequest } from "./openai-compatible.ts";

// The wire types we use. Deliberately small: only the fields this harness reads or writes.
export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
// Other block types (redacted thinking, fallback markers) are passed back untouched.
export type OtherBlock = { type: string; [key: string]: unknown };
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | OtherBlock;

export type Message = { role: "user" | "assistant"; content: string | Array<ContentBlock | ToolResultBlock> };

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: JsonSchema;
};

export type JsonSchema = {
  type?: "object" | "string" | "boolean" | "integer" | "number" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type MessageResponse = {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "stop_sequence" | null;
  usage: Usage;
};

export type MessageRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" };
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    format?: { type: "json_schema"; schema: unknown };
  };
  fallbacks?: "default";
};

export type Provider = "anthropic" | "openai-compatible";

export function provider(env: Record<string, string | undefined> = process.env): Provider {
  const p = env.MODEL_PROVIDER ?? "anthropic";
  if (p !== "anthropic" && p !== "openai-compatible") {
    throw new Error(`MODEL_PROVIDER must be "anthropic" or "openai-compatible"; got "${p}"`);
  }
  return p;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`model API ${status}: ${body.slice(0, 500)}`);
  }
}

// Retry only what is worth retrying: rate limits, overload, server errors, network failures.
// A 400 means our request is wrong; retrying it would hide a harness bug.
async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts) throw new ApiError(res.status, text);
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
  }
}

const backoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- anthropic ---------------------------------------------------------------------------

const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
const API_VERSION = "2026-10-21";
// Server-side refusal fallback: if a safety classifier declines, the API reruns the request on
// a suitable model inside the same call. Opt-in, because some gateways reject the field.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function anthropicHeaders(betas: string[]): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "anthropic-version": API_VERSION };
  if (process.env.ANTHROPIC_API_KEY) h["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  else if (process.env.ANTHROPIC_AUTH_TOKEN) h.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  else throw new Error("Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or set MODEL_PROVIDER=openai-compatible.");
  if (betas.length > 0) h["anthropic-beta"] = betas.join(",");
  return h;
}

// ---- openai-compatible -------------------------------------------------------------------

// Ollama's default. Override with MODEL_BASE_URL (e.g. https://api.openai.com/v1).
const OPENAI_URL = (process.env.MODEL_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, "");

function openaiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // Local servers usually need no key; hosted ones do.
  if (process.env.MODEL_API_KEY) h.authorization = `Bearer ${process.env.MODEL_API_KEY}`;
  return h;
}

// ---- the two calls the harness makes -----------------------------------------------------

export async function createMessage(req: MessageRequest): Promise<MessageResponse> {
  if (provider() === "openai-compatible") {
    const res = await post<unknown>(`${OPENAI_URL}/chat/completions`, openaiHeaders(), toChatRequest(req));
    return fromChatResponse(res);
  }
  const betas = req.fallbacks ? [FALLBACK_BETA] : [];
  return post<MessageResponse>(`${ANTHROPIC_URL}/v1/messages`, anthropicHeaders(betas), req);
}

// Token counting makes no generation. We use it to measure what the tool definitions cost on
// their own. OpenAI-compatible servers have no counting endpoint, so there it is an estimate
// (about 4 characters per token); real per-call counts still come back in each response.
export async function countTokens(req: Omit<MessageRequest, "max_tokens" | "fallbacks">): Promise<number> {
  if (provider() === "openai-compatible") return estimateTokens(req);
  const res = await post<{ input_tokens: number }>(
    `${ANTHROPIC_URL}/v1/messages/count_tokens`,
    anthropicHeaders([]),
    req,
  );
  return res.input_tokens;
}

export const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
