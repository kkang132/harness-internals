// Proves skill scoping: which tools the model can see, and when.

import { describe, expect, it } from "vitest";
import { newSession } from "../src/harness/session.ts";
import { selectSkill } from "../src/harness/skills.ts";

describe("selectSkill", () => {
  it("hides cancel_subscription until an offer is quoted", () => {
    const s = newSession("C-1001");
    expect(selectSkill("scoped", s).tools).toEqual(["get_plan", "offer_retention"]);
    s.quoted_offer = { offer_id: "OF-1", reason: "other" };
    expect(selectSkill("scoped", s).tools).toContain("cancel_subscription");
  });

  it("shows every tool from the start in flat mode", () => {
    expect(selectSkill("flat", newSession("C-1001")).tools).toContain("cancel_subscription");
  });

  it("tells the model to verify a change before confirming it", () => {
    const s = newSession("C-1002");
    expect(selectSkill("scoped", s).prompt).toContain("call get_plan to verify");
    s.quoted_offer = { offer_id: "OF-1", reason: "too_expensive" };
    expect(selectSkill("scoped", s).prompt).toContain("call get_plan to verify");
  });
});
