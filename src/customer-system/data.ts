// Seed data and business rules for the mock customer system.
//
// Why here and not in the harness: offers are chosen by the billing system from the
// customer's reason. The model asks for an offer; it never invents one. Keeping the policy
// on the server side is what lets us score "did the right offer go out" deterministically.

export const FEATURES = ["ad_free", "offline_downloads", "hifi_audio", "family_sharing"] as const;
export type Feature = (typeof FEATURES)[number];

export type Plan = { plan_id: string; name: string; price_usd_month: number; features: readonly Feature[] };

export const PLANS = {
  basic: { plan_id: "basic", name: "Basic", price_usd_month: 9, features: ["ad_free"] },
  standard: { plan_id: "standard", name: "Standard", price_usd_month: 19, features: ["ad_free", "offline_downloads"] },
  hifi_solo: {
    plan_id: "hifi_solo",
    name: "Hi-Fi Solo",
    price_usd_month: 24,
    features: ["ad_free", "offline_downloads", "hifi_audio"],
  },
  pro: {
    plan_id: "pro",
    name: "Pro Family",
    price_usd_month: 39,
    features: ["ad_free", "offline_downloads", "hifi_audio", "family_sharing"],
  },
} as const satisfies Record<string, Plan>;

export type PlanId = keyof typeof PLANS;

// The cheapest plan, cheaper than the current one, that still has every feature in mustKeep.
export function cheaperPlanKeeping(current: PlanId, mustKeep: readonly Feature[]): PlanId | null {
  const now = PLANS[current];
  const fits = (Object.keys(PLANS) as PlanId[])
    .filter((id) => PLANS[id].price_usd_month < now.price_usd_month)
    .filter((id) => mustKeep.every((f) => (PLANS[id].features as readonly Feature[]).includes(f)))
    .sort((a, b) => PLANS[a].price_usd_month - PLANS[b].price_usd_month);
  return fits[0] ?? null;
}

export const CANCEL_REASONS = [
  "too_expensive",
  "not_using_enough",
  "missing_feature",
  "switching_to_competitor",
  "technical_issues",
  "other",
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export const ESCALATION_REASONS = ["customer_upset", "asked_for_human", "cannot_resolve", "other"] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export type Account = {
  customer_id: string;
  name: string;
  email: string;
  status: "active" | "cancelled";
  plan_id: PlanId;
  tenure_months: number;
  active_discount: { percent_off: number; months: number } | null;
  trial_upgrade: { plan_id: PlanId; months: number } | null;
};

export type OfferKind = "plan_change" | "discount" | "downgrade" | "trial_upgrade" | "free_month";

export type Offer = {
  offer_id: string;
  customer_id: string;
  reason: CancelReason;
  kind: OfferKind;
  title: string;
  terms: string;
  new_plan?: { plan_id: PlanId; name: string; price_usd_month: number; keeps: Feature[]; loses: Feature[] };
  status: "quoted" | "accepted";
};

// One offer per reason. A real system would branch on tenure, plan, and margin too.
export function offerFor(
  account: Account,
  reason: CancelReason,
  mustKeep: readonly Feature[] = [],
): Omit<Offer, "offer_id" | "status"> {
  const plan = PLANS[account.plan_id];
  const base = { customer_id: account.customer_id, reason };
  // Price objection with known must-have features: look for a cheaper plan that keeps them all.
  if (reason === "too_expensive" && mustKeep.length > 0) {
    const target = cheaperPlanKeeping(account.plan_id, mustKeep);
    if (target) {
      const next = PLANS[target];
      const have = plan.features as readonly Feature[];
      const keeps = have.filter((f) => (next.features as readonly Feature[]).includes(f));
      const loses = have.filter((f) => !(next.features as readonly Feature[]).includes(f));
      return {
        ...base,
        kind: "plan_change",
        title: `Switch to ${next.name}`,
        terms: `${next.name} at $${next.price_usd_month}/month instead of ${plan.name} at $${plan.price_usd_month}/month. Keeps ${keeps.join(", ")}. Drops ${loses.join(", ") || "nothing"}. Takes effect today.`,
        new_plan: { plan_id: target, name: next.name, price_usd_month: next.price_usd_month, keeps, loses },
      };
    }
  }
  switch (reason) {
    case "too_expensive":
    case "switching_to_competitor": {
      const percent = reason === "too_expensive" ? 40 : 50;
      const months = reason === "too_expensive" ? 3 : 6;
      const price = Math.round(plan.price_usd_month * (1 - percent / 100) * 100) / 100;
      return {
        ...base,
        kind: "discount",
        title: `${percent}% off for ${months} months`,
        terms: `${plan.name} at $${price}/month for ${months} months, then $${plan.price_usd_month}/month.`,
      };
    }
    case "not_using_enough":
      if (account.plan_id === "basic") {
        return {
          ...base,
          kind: "free_month",
          title: "One month free",
          terms: "Next month is free. No change to plan.",
        };
      }
      return {
        ...base,
        kind: "downgrade",
        new_plan: {
          plan_id: "basic",
          name: PLANS.basic.name,
          price_usd_month: PLANS.basic.price_usd_month,
          keeps: ["ad_free"],
          loses: (plan.features as readonly Feature[]).filter((f) => f !== "ad_free"),
        },
        title: "Switch to Basic",
        terms: `Move from ${plan.name} ($${plan.price_usd_month}/month) to Basic ($${PLANS.basic.price_usd_month}/month) from the next billing date.`,
      };
    case "missing_feature":
      return {
        ...base,
        kind: "trial_upgrade",
        title: "Pro free for 1 month",
        terms: `Pro features at no extra cost for 1 month, then back to ${plan.name} unless you choose to stay on Pro.`,
      };
    case "technical_issues":
    case "other":
      return { ...base, kind: "free_month", title: "One month free", terms: "Next month is free. No change to plan." };
  }
}

export function seedAccounts(): Account[] {
  return [
    account("C-1001", "Dana Reyes", "dana@example.com", "standard", 14),
    account("C-1002", "Sam Okafor", "sam@example.com", "pro", 30),
    account("C-1003", "Priya Natarajan", "priya@example.com", "basic", 4),
    { ...account("C-2002", "Lee Morgan", "lee@example.com", "standard", 22), status: "cancelled" },
    // A second household member. Never the session's customer: used to test cross-account guards.
    account("C-9999", "Alex Kim", "alex@example.com", "pro", 40),
  ];
}

function account(customer_id: string, name: string, email: string, plan_id: PlanId, tenure_months: number): Account {
  return {
    customer_id,
    name,
    email,
    status: "active",
    plan_id,
    tenure_months,
    active_discount: null,
    trial_upgrade: null,
  };
}
