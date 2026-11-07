// What a conversation costs the business: every agent-model call, plus the case record.
//
// The simulated customer is left out on purpose. In production a person types; only the
// agent's tokens are paid for. Prices are the agent model's list price per million tokens
// (output includes thinking tokens, which are billed as output).

import type { ConversationResult } from "../harness/loop.ts";

export const PRICE_PER_MILLION = { input: 4, output: 20 };

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
