// Proves the OpenAI-compatible adapter: our message format translates to chat completions and
// back without losing tool calls, tool results, errors or usage. No model is called.

import { describe, expect, it } from "vitest";
import { ALL_SKILLS, toolDefinitions } from "../src/harness/skills.ts";
import { type MessageRequest, provider } from "../src/llm/model-api.ts";
import { estimateTokens, fromChatResponse, parseArguments, toChatRequest } from "../src/llm/openai-compatible.ts";

const base: MessageRequest = { model: "gpt-oss:20b", max_tokens: 1000, messages: [] };

describe("provider", () => {
  it("defaults to anthropic and accepts openai-compatible", () => {
    expect(provider({})).toBe("anthropic");
    expect(provider({ MODEL_PROVIDER: "openai-compatible" })).toBe("openai-compatible");
  });

  it("rejects anything else", () => {
    expect(() => provider({ MODEL_PROVIDER: "gemini" })).toThrow(/MODEL_PROVIDER/);
  });
});

describe("toChatRequest", () => {
  it("puts the system prompt first and maps tools to functions", () => {
    const out = toChatRequest({ ...base, system: "Be brief.", tools: toolDefinitions(ALL_SKILLS.retention) });
    expect(out.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(out.tools?.map((t) => t.function.name)).toEqual(["get_plan", "offer_retention", "escalate_to_human"]);
    expect(out.tools?.[1]?.function.parameters).toEqual(toolDefinitions(ALL_SKILLS.retention)[1]?.input_schema);
  });

  it("turns tool_use blocks into tool_calls and drops thinking", () => {
    const out = toChatRequest({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "look it up" },
            { type: "text", text: "One moment." },
            { type: "tool_use", id: "t1", name: "get_plan", input: {} },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: "One moment.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "get_plan", arguments: "{}" } }],
      },
    ]);
  });

  it("turns each tool_result into a tool message, and marks errors", () => {
    const out = toChatRequest({
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: '{"plan":"pro"}' },
            { type: "tool_result", tool_use_id: "t2", content: "invalid tool input", is_error: true },
          ],
        },
      ],
    });
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t1", content: '{"plan":"pro"}' },
      { role: "tool", tool_call_id: "t2", content: "ERROR: invalid tool input" },
    ]);
  });

  it("maps structured output to response_format json_schema, and drops effort", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    const out = toChatRequest({ ...base, output_config: { effort: "low", format: { type: "json_schema", schema } } });
    expect(out.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", schema, strict: true } });
    expect(JSON.stringify(out)).not.toContain("effort");
  });
});

describe("fromChatResponse", () => {
  it("turns tool_calls into tool_use blocks with parsed input", () => {
    const res = fromChatResponse({
      id: "c1",
      model: "gpt-oss:20b",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: { name: "offer_retention", arguments: '{"reason":"too_expensive","action":"quote"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 812, completion_tokens: 40 },
    });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toEqual([
      { type: "tool_use", id: "call_1", name: "offer_retention", input: { reason: "too_expensive", action: "quote" } },
    ]);
    expect(res.usage).toEqual({ input_tokens: 812, output_tokens: 40 });
  });

  it("counts tool calls even when the server says 'stop'", () => {
    const res = fromChatResponse({
      choices: [
        { finish_reason: "stop", message: { tool_calls: [{ function: { name: "get_plan", arguments: "" } }] } },
      ],
    });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content[0]).toMatchObject({ type: "tool_use", name: "get_plan", input: {} });
  });

  it("maps a text reply, separate reasoning, and finish reasons", () => {
    const res = fromChatResponse({
      choices: [{ finish_reason: "length", message: { content: " Hello ", reasoning: "greet them" } }],
    });
    expect(res.content).toEqual([
      { type: "thinking", thinking: "greet them" },
      { type: "text", text: "Hello" },
    ]);
    expect(res.stop_reason).toBe("max_tokens");
    expect(fromChatResponse({ choices: [{ finish_reason: "stop", message: { content: "x" } }] }).stop_reason).toBe(
      "end_turn",
    );
  });

  it("fails loudly on a response with no message", () => {
    expect(() => fromChatResponse({ choices: [] })).toThrow(/no message/);
  });
});

describe("parseArguments", () => {
  it("keeps broken JSON under a key every tool schema rejects", () => {
    expect(parseArguments('{"reason": "too_exp')).toEqual({ _unparseable_arguments: '{"reason": "too_exp' });
  });
});

describe("estimateTokens", () => {
  it("grows with the tool definitions", () => {
    const req = { model: "m", system: "s", messages: [{ role: "user" as const, content: "Hi" }] };
    expect(estimateTokens({ ...req, tools: toolDefinitions(ALL_SKILLS.cancellation) })).toBeGreaterThan(
      estimateTokens({ ...req, tools: toolDefinitions(ALL_SKILLS.retention) }),
    );
  });
});
