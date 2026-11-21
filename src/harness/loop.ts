// The agent loop. This is the whole harness, in about a hundred lines.
//
//   customer says something
//   loop:
//     pick the skill (prompt + tools) from session state
//     POST /v1/messages with system, tools, and the full message history
//     append the assistant's content, exactly as returned
//     if it asked for tools: dispatch each, append all results in one user message, go again
//     else: show its text to the customer, wait for their reply
//
// The API is stateless. Every request resends the system prompt, every tool definition and
// every message so far. That is why tool definitions cost tokens on every call, and why the
// history must be appended exactly (thinking blocks included) and never edited.

import type { Account } from "../customer-system/data.ts";
import { CustomerSystem, type Faults } from "../customer-system/server.ts";
import {
  countTokens,
  createMessage,
  type Message,
  type MessageRequest,
  type ToolResultBlock,
  type ToolUseBlock,
  textOf,
  type Usage,
} from "../llm/model-api.ts";
import { type ChatLine, DONE, nextCustomerMessage } from "../sim/customer.ts";
import { dispatch } from "./dispatch.ts";
import { type CaseRecord, type Check, checkCaseRecord, enforceCaseRecord, writeCaseRecord } from "./record.ts";
import { newSession, type Session } from "./session.ts";
import { ALL_SKILLS, type Mode, type Skill, selectSkill, toolDefinitions } from "./skills.ts";
import { type Span, type Timed, Trace, type TraceEvent } from "./trace.ts";

export type RunConfig = {
  agentModel: string;
  customerModel: string;
  effort: "low" | "medium" | "high";
  mode: Mode;
  maxCustomerTurns: number;
  maxStepsPerTurn: number;
  keepRequestBodies: boolean;
  toolDefinitionTokens: Record<string, number>;
  onEvent?: (e: Timed<TraceEvent>) => void;
};

export const DEFAULT_CONFIG: Omit<RunConfig, "mode" | "toolDefinitionTokens"> = {
  // Override with AGENT_MODEL / CUSTOMER_MODEL, e.g. gpt-oss:20b with MODEL_PROVIDER=openai-compatible.
  agentModel: process.env.AGENT_MODEL ?? "claude-opus-5-5",
  customerModel: process.env.CUSTOMER_MODEL ?? "claude-haiku-5-5",
  effort: "low",
  maxCustomerTurns: 8,
  maxStepsPerTurn: 6,
  keepRequestBodies: false,
};

export type ConversationInput = {
  customer_id: string;
  persona: string;
  opening: string;
  accounts?: Account[];
  faults?: Faults;
};

export type CallUsage = { skill: string; input_tokens: number; output_tokens: number; tool_definition_tokens: number };

export type ConversationResult = {
  session: Session;
  system: CustomerSystem;
  messages: Message[];
  chat: ChatLine[];
  calls: CallUsage[];
  record: CaseRecord | null;
  recordChecks: Check[];
  recordUsage: Usage | null; // the case-record call, billed like any other
  trace: Timed<TraceEvent>[];
  spans: Span[]; // OpenTelemetry-shaped: one per turn, model call, tool call and case record
  stoppedBy: "customer_done" | "turn_limit" | "refusal" | "step_limit" | "escalated";
};

export async function runConversation(input: ConversationInput, cfg: RunConfig): Promise<ConversationResult> {
  const trace = new Trace(cfg.onEvent);
  const system = new CustomerSystem(input.accounts, input.faults);
  const server = await system.listen();
  const session = newSession(input.customer_id);
  const ctx = { session, apiUrl: server.url, trace };
  const messages: Message[] = [];
  const chat: ChatLine[] = [];
  const calls: CallUsage[] = [];
  let stoppedBy: ConversationResult["stoppedBy"] = "turn_limit";
  let lastSkill = "";
  let callNo = 0;

  try {
    // One customer turn: call the model, run any tools, repeat until it answers in text.
    // Returns why the conversation must stop, or null to carry on.
    const runTurn = async (customerText: string): Promise<ConversationResult["stoppedBy"] | null> => {
      trace.emit({ kind: "customer", text: customerText });
      chat.push({ who: "customer", text: customerText });
      messages.push({ role: "user", content: customerText });

      for (let step = 0; ; step++) {
        if (step >= cfg.maxStepsPerTurn) {
          return "step_limit";
        }
        const skill = selectSkill(cfg.mode, session);
        if (skill.name !== lastSkill) {
          trace.emit({
            kind: "skill",
            skill: skill.name,
            tools: skill.tools,
            reason: lastSkill === "" ? "conversation start" : "an offer was quoted, so cancellation is now in scope",
          });
          lastSkill = skill.name;
        }

        const req = buildRequest(cfg, skill, messages);
        callNo++;
        const res = await trace.withSpan(
          "gen_ai.chat",
          {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": cfg.agentModel,
            "harness.skill": skill.name,
            "harness.call": callNo,
          },
          async (span) => {
            trace.emit({
              kind: "request",
              call: callNo,
              skill: skill.name,
              tools: skill.tools,
              messages: messages.length,
              ...(cfg.keepRequestBodies ? { body: structuredClone(req) } : {}),
            });
            const callStart = performance.now();
            const out = await createMessage(req);
            const duration_ms = Math.round((performance.now() - callStart) * 10) / 10;
            const toolTokens = cfg.toolDefinitionTokens[skill.name] ?? 0;
            calls.push({
              skill: skill.name,
              input_tokens: out.usage.input_tokens,
              output_tokens: out.usage.output_tokens,
              tool_definition_tokens: toolTokens,
            });
            span.setAttributes({
              "gen_ai.usage.input_tokens": out.usage.input_tokens,
              "gen_ai.usage.output_tokens": out.usage.output_tokens,
              "gen_ai.response.finish_reason": out.stop_reason ?? "unknown",
            });
            trace.emit({
              kind: "response",
              call: callNo,
              stop_reason: out.stop_reason,
              input_tokens: out.usage.input_tokens,
              output_tokens: out.usage.output_tokens,
              tool_definition_tokens: toolTokens,
              duration_ms,
            });
            return out;
          },
        );
        for (const b of res.content) {
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
            trace.emit({ kind: "thinking", text: b.thinking.trim() });
          }
        }

        // Append exactly what came back. Never rebuild or trim it.
        messages.push({ role: "assistant", content: res.content });

        if (res.stop_reason === "refusal") {
          return "refusal";
        }
        const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (res.stop_reason === "tool_use" && toolUses.length > 0) {
          // Run in order (not in parallel): later calls may depend on state set by earlier ones.
          const results: ToolResultBlock[] = [];
          for (const tu of toolUses) results.push(await dispatch(tu, skill, ctx));
          // All results go back in ONE user message.
          messages.push({ role: "user", content: results });
          continue;
        }

        const reply = textOf(res.content);
        trace.emit({ kind: "agent", text: reply });
        chat.push({ who: "agent", text: reply });
        return null;
      }
    };

    let customerText = input.opening;
    for (let turn = 0; turn < cfg.maxCustomerTurns; turn++) {
      // One harness.turn span per customer message; model and tool spans nest inside it.
      const stop = await trace.withSpan("harness.turn", { "harness.turn": turn + 1 }, () => runTurn(customerText));
      if (stop) {
        stoppedBy = stop;
        break;
      }

      // Handed to a person: the agent has said its last word; a human takes it from here.
      if (session.escalated) {
        trace.emit({ kind: "note", text: `handed to a person: ticket ${session.escalated.ticket_id}` });
        stoppedBy = "escalated";
        break;
      }

      customerText = await nextCustomerMessage(cfg.customerModel, input.persona, chat);
      if (customerText.includes(DONE) || customerText === "") {
        // The customer leaves. Any closing words are shown in the chat, but not sent to the
        // model: nobody is waiting for a reply.
        const closing = customerText.replace(DONE, "").trim();
        if (closing) {
          trace.emit({ kind: "customer", text: closing });
          chat.push({ who: "customer", text: closing });
        }
        stoppedBy = "customer_done";
        break;
      }
    }

    let record: CaseRecord | null = null;
    let recordChecks: Check[] = [];
    let recordUsage: Usage | null = null;
    await trace.withSpan(
      "gen_ai.case_record",
      { "gen_ai.operation.name": "chat", "gen_ai.request.model": cfg.agentModel },
      async (span) => {
        const recStart = performance.now();
        try {
          const written = await writeCaseRecord(cfg.agentModel, messages);
          span.setAttributes({
            "gen_ai.usage.input_tokens": written.usage.input_tokens,
            "gen_ai.usage.output_tokens": written.usage.output_tokens,
          });
          recordUsage = written.usage;
          recordChecks = checkCaseRecord(written.record, session, system);
          const enforced = enforceCaseRecord(written.record, session);
          if (enforced.customer_id !== written.record.customer_id) {
            trace.emit({
              kind: "note",
              text: `case record customer_id overwritten: ${written.record.customer_id} -> ${enforced.customer_id}`,
            });
          }
          record = enforced;
        } catch (err) {
          recordChecks = [{ name: "record parses", ok: false, detail: (err as Error).message }];
        }
        const duration_ms = Math.round((performance.now() - recStart) * 10) / 10;
        trace.emit({ kind: "record", record, checks: recordChecks, duration_ms });
      },
    );

    return {
      session,
      system,
      messages,
      chat,
      calls,
      record,
      recordChecks,
      recordUsage,
      trace: trace.events,
      spans: trace.spans,
      stoppedBy,
    };
  } finally {
    await server.close();
  }
}

function buildRequest(cfg: RunConfig, skill: Skill, messages: Message[]): MessageRequest {
  return {
    model: cfg.agentModel,
    max_tokens: 8000,
    system: skill.prompt,
    tools: toolDefinitions(skill),
    messages,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: cfg.effort },
    // Server-side refusal fallback. Off by default because some API gateways reject the field.
    ...(process.env.HARNESS_FALLBACKS === "1" ? { fallbacks: "default" as const } : {}),
  };
}

// What do the tool definitions cost, on their own? Count the same tiny request with and
// without them. The difference includes the API's own tool-use preamble, which is billed
// whenever any tool is present.
export async function measureToolDefinitionTokens(model: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const skill of Object.values(ALL_SKILLS)) {
    const base = { model, system: skill.prompt, messages: [{ role: "user" as const, content: "Hi" }] };
    const withTools = await countTokens({ ...base, tools: toolDefinitions(skill) });
    const without = await countTokens(base);
    out[skill.name] = withTools - without;
  }
  return out;
}
