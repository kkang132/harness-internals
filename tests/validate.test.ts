// Proves the tool schemas and the validator: what the model may send, and what it may not.

import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/harness/tools.ts";
import { validate } from "../src/harness/validate.ts";

describe("tool schemas", () => {
  it("never mention customer_id, offer_id or an idempotency key", () => {
    const all = JSON.stringify(TOOL_DEFINITIONS);
    expect(all).not.toContain("customer_id");
    expect(all).not.toContain("offer_id");
    expect(all.toLowerCase()).not.toContain("idempotency");
  });

  it("reject a customer_id the model adds on its own", () => {
    const errors = validate(TOOL_DEFINITIONS.get_plan.input_schema, { customer_id: "C-9999" });
    expect(errors.map((e) => e.path)).toEqual(["input.customer_id"]);
  });

  it("reject an unknown reason and a missing field", () => {
    const errors = validate(TOOL_DEFINITIONS.offer_retention.input_schema, { reason: "price" });
    expect(errors.map((e) => e.path).sort()).toEqual(["input.action", "input.reason"]);
  });

  it("check every item of must_keep_features against the feature list", () => {
    const schema = TOOL_DEFINITIONS.offer_retention.input_schema;
    const ok = { reason: "too_expensive", action: "quote", must_keep_features: ["hifi_audio"] };
    expect(validate(schema, ok)).toEqual([]);
    const bad = validate(schema, { ...ok, must_keep_features: ["hifi_audio", "karaoke"] });
    expect(bad.map((e) => e.path)).toEqual(["input.must_keep_features[1]"]);
  });

  it("require customer_confirmed to be literally true", () => {
    const errors = validate(TOOL_DEFINITIONS.cancel_subscription.input_schema, {
      reason: "other",
      customer_confirmed: false,
    });
    expect(errors).toHaveLength(1);
  });
});

describe("validate", () => {
  it("reports type mismatches with the value's type", () => {
    expect(validate({ type: "string" }, 3)[0]?.message).toBe("must be a string; got number");
    expect(validate({ type: "object" }, [])[0]?.message).toBe("must be an object; got array");
  });
});
