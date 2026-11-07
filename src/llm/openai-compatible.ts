// Adapter for any OpenAI-compatible chat completions API: OpenAI, Ollama, vLLM, LM Studio.
//
// Why an adapter and not a second harness: the harness, the checks, the eval and the viewer
// all speak one message format (content blocks, tool_use, tool_result). This file translates
// at the edge, both ways, so swapping the model touches nothing else. Pure functions: the
// translation is unit-tested without calling any model.
//
// What does not carry over:
//   - thinking and effort settings are dropped (each server has its own, if any);
//   - thinking blocks in the history are not sent back;
//   - structured output becomes response_format json_schema, which not every server honours.

import type {
  ContentBlock,
  Message,
  MessageRequest,
  MessageResponse,
  ToolResultBlock,
  ToolUseBlock,
} from "./model-api.ts";

// ---- the OpenAI chat shapes we use -------------------------------------------------------

export type ChatToolCall = { id?: string; type?: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatRequest = {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: unknown; strict: boolean } };
};

type ChatResponse = {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; reasoning?: string | null; tool_calls?: ChatToolCall[] | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// ---- request: our format -> chat completions ---------------------------------------------

export function toChatRequest(req: MessageRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push(...toChatMessages(m));

  const out: ChatRequest = { model: req.model, max_tokens: req.max_tokens, messages };
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  const format = req.output_config?.format;
  if (format?.type === "json_schema") {
    out.response_format = { type: "json_schema", json_schema: { name: "output", schema: format.schema, strict: true } };
  }
  return out;
}

function toChatMessages(m: Message): ChatMessage[] {
  if (typeof m.content === "string") return [{ role: m.role, content: m.content }];

  if (m.role === "assistant") {
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const calls = m.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    return [{ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
  }

  // A user turn: tool results become one "tool" message each; any text stays a user message.
  const out: ChatMessage[] = [];
  for (const b of m.content as Array<ContentBlock | ToolResultBlock>) {
    if (b.type === "tool_result") {
      const r = b as ToolResultBlock;
      out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.is_error ? `ERROR: ${r.content}` : r.content });
    } else if (b.type === "text") {
      out.push({ role: "user", content: (b as { text: string }).text });
    }
  }
  return out;
}

// ---- response: chat completions -> our format --------------------------------------------

let generated = 0;

export function fromChatResponse(raw: unknown): MessageResponse {
  const res = raw as ChatResponse;
  const choice = res.choices?.[0];
  if (!choice?.message)
    throw new Error(`chat completions response has no message: ${JSON.stringify(raw).slice(0, 300)}`);
  const msg = choice.message;
  const content: ContentBlock[] = [];

  // Some local reasoning models return their reasoning separately. Shown in the trace only.
  if (msg.reasoning?.trim()) content.push({ type: "thinking", thinking: msg.reasoning.trim() });
  if (msg.content?.trim()) content.push({ type: "text", text: msg.content.trim() });

  for (const call of msg.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id || `call_${++generated}`,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }

  const hasTools = content.some((b) => b.type === "tool_use");
  return {
    id: res.id ?? `chat_${++generated}`,
    model: res.model ?? "unknown",
    content,
    // Some servers report "stop" even when they called a tool; the tool calls are what count.
    stop_reason: hasTools ? "tool_use" : stopReason(choice.finish_reason),
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  };
}

// Arguments arrive as a JSON string. If a model writes broken JSON, keep the raw text under a
// key no schema allows, so the harness's schema check rejects it and tells the model why.
export function parseArguments(args: string): unknown {
  if (!args || !args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _unparseable_arguments: args };
  }
}

function stopReason(finish: string | null | undefined): MessageResponse["stop_reason"] {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

// ---- token estimate ------------------------------------------------------------------------

// Chat completions servers have no token-counting endpoint. About 4 characters per token is
// the usual rough rule for English and JSON. Used only for the tool-definition breakdown.
export function estimateTokens(req: Omit<MessageRequest, "max_tokens" | "fallbacks">): number {
  const chars = JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools ?? [] }).length;
  return Math.ceil(chars / 4);
}
