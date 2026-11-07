// What a conversation costs the business: every agent-model call, plus the case record.
//
// The simulated customer is left out on purpose. In production a person types; only the
// agent's tokens are paid for. Prices are the agent model's list price per million tokens
// (output includes thinking tokens, which are billed as output). A local model costs nothing
// per token: with MODEL_PROVIDER=openai-compatible the default is 0, or set MODEL_PRICE_IN and
// MODEL_PRICE_OUT (dollars per million tokens) for a hosted one.

import type { ConversationResult } from "../harness/loop.ts";

import { provider } from "../llm/model-api.ts";

const local = provider() === "openai-compatible";
export const PRICE_PER_MILLION = {
  input: Number(process.env.MODEL_PRICE_IN ?? (local ? 0 : 4)),
  output: Number(process.env.MODEL_PRICE_OUT ?? (local ? 0 : 20)),
};

export function conversationCostUsd(r: Pick<ConversationResult, "calls" | "recordUsage">): number {
  const input = r.calls.reduce((s, c) => s + c.input_tokens, 0) + (r.recordUsage?.input_tokens ?? 0);
  const output = r.calls.reduce((s, c) => s + c.output_tokens, 0) + (r.recordUsage?.output_tokens ?? 0);
  return (input * PRICE_PER_MILLION.input + output * PRICE_PER_MILLION.output) / 1e6;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
