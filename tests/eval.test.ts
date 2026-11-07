// Proves the eval arithmetic: pass^k, the median, and the cost of a conversation.

import { describe, expect, it } from "vitest";
import { conversationCostUsd, median } from "../src/eval/cost.ts";
import { meanPassHatK, passHatK } from "../src/eval/score.ts";

describe("pass^k", () => {
  it("matches the closed form C(c, k) / C(n, k)", () => {
    expect(passHatK(5, 5, 5)).toBe(1);
    expect(passHatK(4, 5, 5)).toBe(0);
    expect(passHatK(4, 5, 1)).toBeCloseTo(0.8);
    expect(passHatK(4, 5, 2)).toBeCloseTo(0.6);
  });

  it("averages over scenarios", () => {
    const per = [
      { passes: 5, runs: 5 },
      { passes: 0, runs: 5 },
    ];
    expect(meanPassHatK(per, 3)).toBe(0.5);
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("conversationCostUsd", () => {
  it("prices agent calls and the case note, at input and output rates", () => {
    const calls = [{ skill: "retention", input_tokens: 1_000_000, output_tokens: 0, tool_definition_tokens: 0 }];
    const recordUsage = { input_tokens: 0, output_tokens: 1_000_000 };
    expect(conversationCostUsd({ calls, recordUsage })).toBe(24);
  });
});
