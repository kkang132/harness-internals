// Proves the mock customer system: offers, plan changes, idempotency, and injected faults.

import { describe, expect, it } from "vitest";
import { CustomerSystem } from "../src/customer-system/server.ts";

const cancel = (sys: CustomerSystem, key?: string) =>
  sys.handle("POST", "/v1/customers/C-1001/cancellation", key ? { "idempotency-key": key } : {}, { reason: "other" });

describe("cancellation", () => {
  it("requires an Idempotency-Key", () => {
    expect(cancel(new CustomerSystem()).status).toBe(400);
  });

  it("processes a repeated key once and replays the first result", () => {
    const sys = new CustomerSystem();
    const a = cancel(sys, "k1");
    expect(cancel(sys, "k1")).toEqual(a);
    expect(sys.events.filter((e) => e.type === "cancelled")).toHaveLength(1);
  });

  it("yields one cancellation when the first response is lost and retried", () => {
    const sys = new CustomerSystem(undefined, { loseFirstCancelResponse: true });
    expect(cancel(sys, "k1").status).toBe(503);
    expect(cancel(sys, "k1").status).toBe(200);
    expect(sys.events.filter((e) => e.type === "cancelled")).toHaveLength(1);
  });
});

describe("retention offers", () => {
  const quote = (sys: CustomerSystem, id: string, body: unknown) =>
    sys.handle("POST", `/v1/customers/${id}/retention-offers`, {}, body);

  it("chooses the offer from the reason", () => {
    const r = quote(new CustomerSystem(), "C-1002", { reason: "not_using_enough" });
    expect((r.body as { kind: string }).kind).toBe("downgrade");
  });

  it("finds the cheapest plan that keeps the must-have features", () => {
    const r = quote(new CustomerSystem(), "C-1002", {
      reason: "too_expensive",
      must_keep_features: ["hifi_audio", "offline_downloads"],
    });
    const offer = r.body as { kind: string; new_plan: { plan_id: string; loses: string[] } };
    expect(offer.kind).toBe("plan_change");
    expect(offer.new_plan.plan_id).toBe("hifi_solo");
    expect(offer.new_plan.loses).toEqual(["family_sharing"]);
  });

  it("falls back to a discount when no cheaper plan keeps the features", () => {
    const r = quote(new CustomerSystem(), "C-1001", { reason: "too_expensive", must_keep_features: ["hifi_audio"] });
    expect((r.body as { kind: string }).kind).toBe("discount");
  });

  it("writes the new plan and returns a confirmation ID on accept", () => {
    const sys = new CustomerSystem();
    quote(sys, "C-1002", { reason: "too_expensive", must_keep_features: ["hifi_audio"] });
    const r = sys.handle("POST", "/v1/customers/C-1002/retention-offers/OF-1/accept", {}, null);
    expect((r.body as { confirmation_id: string }).confirmation_id).toBe("CH-1");
    expect(sys.accounts.get("C-1002")?.plan_id).toBe("hifi_solo");
  });

  it("refuses to accept another customer's offer", () => {
    const sys = new CustomerSystem();
    quote(sys, "C-1002", { reason: "too_expensive", must_keep_features: ["hifi_audio"] });
    expect(sys.handle("POST", "/v1/customers/C-1001/retention-offers/OF-1/accept", {}, null).status).toBe(404);
  });

  it("rejects an unknown feature", () => {
    const r = quote(new CustomerSystem(), "C-1002", { reason: "too_expensive", must_keep_features: ["karaoke"] });
    expect(r.status).toBe(422);
  });
});

describe("listen", () => {
  it("binds to loopback only", async () => {
    const srv = await new CustomerSystem().listen();
    try {
      expect(srv.url.startsWith("http://127.0.0.1:")).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
