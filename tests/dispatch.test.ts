// Proves the dispatcher's five steps: exposure, schema, injection, execution, and the output guard.
// Every failure must come back as an is_error tool_result, never as a thrown error.

import { describe, expect, it } from "vitest";
import { dispatch, foreignCustomerIds } from "../src/harness/dispatch.ts";
import { ALL_SKILLS } from "../src/harness/skills.ts";
import { withSystem } from "./helpers.ts";

const use = (name: string, input: unknown, id = "t1") => ({ type: "tool_use" as const, id, name, input });

describe("dispatch", () => {
  it("returns a schema error to the model as an is_error result", async () => {
    await withSystem({}, "C-1001", async (ctx) => {
      const r = await dispatch(use("get_plan", { customer_id: "C-9999" }), ALL_SKILLS.retention, ctx);
      expect(r.is_error).toBe(true);
      expect(r.content).toContain("customer_id");
    });
  });

  it("refuses a tool outside the current skill", async () => {
    await withSystem({}, "C-1001", async (ctx, sys) => {
      const r = await dispatch(
        use("cancel_subscription", { reason: "other", customer_confirmed: true }),
        ALL_SKILLS.retention,
        ctx,
      );
      expect(r.is_error).toBe(true);
      expect(sys.events.some((e) => e.type === "cancelled")).toBe(false);
    });
  });

  it("adds the session's customer_id to every call", async () => {
    await withSystem({}, "C-1003", async (ctx) => {
      await dispatch(use("get_plan", {}), ALL_SKILLS.retention, ctx);
      const http = ctx.trace.events.find((e) => e.kind === "http");
      expect(http && "path" in http ? http.path : "").toBe("/v1/customers/C-1003");
    });
  });

  it("uses the session's quoted offer on accept, and refuses accept with no quote", async () => {
    await withSystem({}, "C-1002", async (ctx, sys) => {
      const none = await dispatch(
        use("offer_retention", { reason: "too_expensive", action: "accept" }),
        ALL_SKILLS.retention,
        ctx,
      );
      expect(none.is_error).toBe(true);
      await dispatch(
        use("offer_retention", { reason: "too_expensive", action: "quote", must_keep_features: ["hifi_audio"] }),
        ALL_SKILLS.retention,
        ctx,
      );
      const ok = await dispatch(
        use("offer_retention", { reason: "too_expensive", action: "accept" }),
        ALL_SKILLS.cancellation,
        ctx,
      );
      expect(ok.is_error).toBeUndefined();
      expect(sys.accounts.get("C-1002")?.plan_id).toBe("hifi_solo");
    });
  });

  it("withholds a response that belongs to another customer", async () => {
    await withSystem({ wrongCustomerOnFirstLookup: "C-9999" }, "C-1003", async (ctx) => {
      const first = await dispatch(use("get_plan", {}), ALL_SKILLS.retention, ctx);
      expect(first.is_error).toBe(true);
      expect(first.content).not.toContain("Alex");
      const second = await dispatch(use("get_plan", {}, "t2"), ALL_SKILLS.retention, ctx);
      expect(second.is_error).toBeUndefined();
      expect(second.content).toContain("C-1003");
    });
  });

  it("sends the same Idempotency-Key on the retry after a lost response", async () => {
    await withSystem({ loseFirstCancelResponse: true }, "C-1001", async (ctx, sys) => {
      const r = await dispatch(
        use("cancel_subscription", { reason: "other", customer_confirmed: true }),
        ALL_SKILLS.cancellation,
        ctx,
      );
      expect(r.is_error).toBeUndefined();
      const keys = ctx.trace.events.flatMap((e) => (e.kind === "http" && e.idempotency_key ? [e.idempotency_key] : []));
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(sys.events.filter((e) => e.type === "cancelled")).toHaveLength(1);
    });
  });
});

describe("escalate_to_human", () => {
  it("records the hand-off in the session so the loop can end the conversation", async () => {
    await withSystem({}, "C-1001", async (ctx) => {
      const r = await dispatch(
        use("escalate_to_human", { reason: "asked_for_human", summary: "Charged twice; wants a person." }),
        ALL_SKILLS.retention,
        ctx,
      );
      expect(r.is_error).toBeUndefined();
      expect(ctx.session.escalated?.ticket_id).toBe("ESC-1");
    });
  });

  it("rejects a summary that is too short, before any HTTP call", async () => {
    await withSystem({}, "C-1001", async (ctx) => {
      const r = await dispatch(use("escalate_to_human", { reason: "other", summary: "hi" }), ALL_SKILLS.retention, ctx);
      expect(r.is_error).toBe(true);
      expect(ctx.trace.events.some((e) => e.kind === "http")).toBe(false);
    });
  });
  it("wraps each tool call in a span and sends its W3C traceparent on the HTTP call", async () => {
    await withSystem({}, "C-1001", async (ctx) => {
      await ctx.trace.withSpan("harness.turn", { "harness.turn": 1 }, async (turn) => {
        await dispatch(use("get_plan", {}), ALL_SKILLS.retention, ctx);
        const [span] = ctx.trace.spans.filter((s) => s.attributes["gen_ai.operation.name"] === "execute_tool");
        expect(span?.name).toBe("gen_ai.execute_tool get_plan");
        expect(span?.parent_span_id).toBe(turn.span_id);
        expect(span?.traceparent).toBe(`00-${ctx.trace.trace_id}-${span?.span_id}-01`);
        const http = ctx.trace.events.find((e) => e.kind === "http");
        expect(http?.kind === "http" && http.traceparent).toBe(span?.traceparent);
        expect(http?.span_id).toBe(span?.span_id);
      });
      expect(ctx.trace.events.every((e) => e.trace_id === ctx.trace.trace_id && e.span_id.length === 16)).toBe(true);
    });
  });
});

describe("foreignCustomerIds", () => {
  it("finds nested foreign customer_ids", () => {
    expect(foreignCustomerIds({ offer: { customer_id: "C-1" }, account: { customer_id: "C-2" } }, "C-1")).toEqual([
      "C-2",
    ]);
  });
});
