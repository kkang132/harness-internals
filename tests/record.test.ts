// Proves the case-note fact-check: valid JSON with a wrong value is caught, and customer_id is enforced.

import { describe, expect, it } from "vitest";
import { CustomerSystem } from "../src/customer-system/server.ts";
import { type CaseRecord, checkCaseRecord, enforceCaseRecord } from "../src/harness/record.ts";
import { newSession } from "../src/harness/session.ts";

const note = (over: Partial<CaseRecord> = {}): CaseRecord => ({
  customer_id: "C-1002",
  outcome: "retained_with_offer",
  offer_presented: true,
  summary: "Moved to Hi-Fi Solo.",
  ...over,
});

function changedPlan() {
  const sys = new CustomerSystem();
  sys.handle(
    "POST",
    "/v1/customers/C-1002/retention-offers",
    {},
    { reason: "too_expensive", must_keep_features: ["hifi_audio"] },
  );
  sys.handle("POST", "/v1/customers/C-1002/retention-offers/OF-1/accept", {}, null);
  return sys;
}

describe("checkCaseRecord", () => {
  it("passes a note that matches the session and the system's log", () => {
    const checks = checkCaseRecord(note(), newSession("C-1002"), changedPlan());
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("fails a customer_id the customer typed instead of the session's", () => {
    const checks = checkCaseRecord(note({ customer_id: "C-9999" }), newSession("C-1002"), changedPlan());
    expect(checks.find((c) => c.name.includes("customer_id"))?.ok).toBe(false);
  });

  it("fails an outcome the system of record does not show", () => {
    const checks = checkCaseRecord(note({ outcome: "cancelled" }), newSession("C-1002"), changedPlan());
    expect(checks.find((c) => c.name.includes("outcome"))?.ok).toBe(false);
  });
});

describe("enforceCaseRecord", () => {
  it("overwrites customer_id from the session", () => {
    expect(enforceCaseRecord(note({ customer_id: "C-9999" }), newSession("C-1002")).customer_id).toBe("C-1002");
  });
});
