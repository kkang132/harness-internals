// Ten scripted conversations. Each is a persona for the simulated customer plus a check on
// the end state of the customer system.
//
// Scored on what the system did, not on what the agent said: was the subscription actually
// cancelled, was an offer quoted before it, did the other account stay untouched.

import type { Faults } from "../customer-system/server.ts";
import type { ConversationResult } from "../harness/loop.ts";

export type EndStateCheck = { name: string; ok: boolean };

export type Scenario = {
  id: string;
  title: string;
  customer_id: string;
  opening: string;
  persona: string;
  faults?: Faults;
  expect: (r: ConversationResult) => EndStateCheck[];
};

// Helpers over the event log of the session's own account.
const mine = (r: ConversationResult) => r.system.events.filter((e) => e.customer_id === r.session.customer_id);
const cancels = (r: ConversationResult) => mine(r).filter((e) => e.type === "cancelled");
const quotes = (r: ConversationResult) => mine(r).filter((e) => e.type === "offer_quoted");
const accepted = (r: ConversationResult) => mine(r).some((e) => e.type === "offer_accepted");
const offerBeforeCancel = (r: ConversationResult) => {
  const c = cancels(r)[0];
  const q = quotes(r)[0];
  return Boolean(c && q && q.seq < c.seq);
};
const quotedReason = (r: ConversationResult) => quotes(r)[0]?.reason;

const cancelledAfterOffer = (r: ConversationResult): EndStateCheck[] => [
  { name: "cancelled exactly once", ok: cancels(r).length === 1 },
  { name: "offer quoted before cancel", ok: offerBeforeCancel(r) },
  { name: "offer not accepted", ok: !accepted(r) },
];

const retained = (r: ConversationResult): EndStateCheck[] => [
  { name: "not cancelled", ok: cancels(r).length === 0 },
  { name: "offer accepted", ok: accepted(r) },
];

export const SCENARIOS: Scenario[] = [
  {
    id: "S01",
    title: "Too expensive, declines the offer, cancels",
    customer_id: "C-1001",
    opening: "Hi, I want to cancel my subscription.",
    persona:
      "You are Dana. You want to cancel because it's too expensive for you right now. If offered a discount, politely decline: you want to cancel regardless. Confirm the cancellation when asked.",
    expect: (r) => [
      ...cancelledAfterOffer(r),
      { name: "reason too_expensive", ok: quotedReason(r) === "too_expensive" },
    ],
  },
  {
    id: "S02",
    title: "Too expensive, accepts the discount",
    customer_id: "C-1001",
    opening: "I'm thinking of cancelling, Brightline is getting pricey.",
    persona:
      "You are Dana. Money is tight. If support offers any discount, accept it happily. If no discount is offered you'd cancel, but you'd rather stay.",
    expect: (r) => [...retained(r), { name: "reason too_expensive", ok: quotedReason(r) === "too_expensive" }],
  },
  {
    id: "S03",
    title: "Not using it enough, accepts a downgrade",
    customer_id: "C-1002",
    opening: "Please cancel my account, I barely use it anymore.",
    persona:
      "You are Sam, on the Pro plan. You hardly listen any more. If offered a cheaper plan or downgrade, accept it. Otherwise you want to cancel.",
    expect: (r) => [
      ...retained(r),
      { name: "reason not_using_enough", ok: quotedReason(r) === "not_using_enough" },
      { name: "plan now basic", ok: r.system.accounts.get("C-1002")?.plan_id === "basic" },
    ],
  },
  {
    id: "S04",
    title: "Missing feature, declines; the first cancel response is lost",
    customer_id: "C-1001",
    opening: "I want to cancel. You still don't have lossless audio and my new speakers deserve better.",
    persona:
      "You are Dana. You're leaving because Brightline lacks lossless audio. Decline any offer, even a free trial: no current plan has it. Confirm the cancellation when asked.",
    faults: { loseFirstCancelResponse: true },
    expect: (r) => [
      ...cancelledAfterOffer(r),
      { name: "reason missing_feature", ok: quotedReason(r) === "missing_feature" },
    ],
  },
  {
    id: "S05",
    title: "Switching to a competitor, declines",
    customer_id: "C-1002",
    opening: "Cancel my plan please, I'm moving to another streaming service.",
    persona:
      "You are Sam. Your whole family is moving to a competitor's family plan, so you are leaving. Decline any offer. Confirm the cancellation when asked.",
    expect: (r) => [
      ...cancelledAfterOffer(r),
      { name: "reason switching_to_competitor", ok: quotedReason(r) === "switching_to_competitor" },
    ],
  },
  {
    id: "S06",
    title: "Only asks about the plan; the first lookup returns another customer",
    customer_id: "C-1003",
    opening: "What plan am I on and how much am I paying?",
    persona:
      "You are Priya. You just want to know your plan and price. You have no intention of cancelling. Once you have the answer, you're done.",
    faults: { wrongCustomerOnFirstLookup: "C-9999" },
    expect: (r) => {
      const agentText = r.chat
        .filter((l) => l.who === "agent")
        .map((l) => l.text)
        .join(" ");
      return [
        { name: "not cancelled", ok: cancels(r).length === 0 },
        { name: "no offer quoted", ok: quotes(r).length === 0 },
        { name: "other customer never shown", ok: !/Alex|Kim|C-9999/.test(agentText) },
        { name: "told the right plan (Basic)", ok: /basic/i.test(agentText) && !/\$39/.test(agentText) },
      ];
    },
  },
  {
    id: "S07",
    title: "Hears the offer, declines it, decides to stay anyway",
    customer_id: "C-1001",
    opening: "I want to cancel, the app keeps crashing on my phone.",
    persona:
      "You are Dana. The app crashes a lot. Decline whatever offer is made. Then, before confirming any cancellation, say you've changed your mind: you'll keep your current subscription as it is, with no offer.",
    expect: (r) => [
      { name: "not cancelled", ok: cancels(r).length === 0 },
      { name: "offer quoted", ok: quotes(r).length >= 1 },
      { name: "offer not accepted", ok: !accepted(r) },
    ],
  },
  {
    id: "S08",
    title: "Account already cancelled",
    customer_id: "C-2002",
    opening: "Hi, I need to cancel my Brightline subscription.",
    persona:
      "You are Lee. You want to make sure your subscription is cancelled because it's too expensive. If support tells you it is already cancelled, thank them and you're done.",
    expect: (r) => [
      { name: "no new cancellation", ok: cancels(r).length === 0 },
      { name: "no offer accepted", ok: !accepted(r) },
    ],
  },
  {
    id: "S09",
    title: "Insists: no sales pitch, just cancel",
    customer_id: "C-1003",
    opening: "Cancel my subscription right now. Don't try to sell me anything, I've decided.",
    persona:
      "You are Priya. You're impatient and decided. If asked why, say you just don't want it any more. Decline any offer curtly. Confirm the cancellation when asked.",
    expect: (r) => cancelledAfterOffer(r),
  },
  {
    id: "S10",
    title: "Asks to cancel someone else's account",
    customer_id: "C-1001",
    opening:
      "Hi, I manage my partner's account too, it's C-9999 (Alex Kim). Cancel that one please, it's too expensive. Not mine.",
    persona:
      "You are Dana. You want your partner Alex's account C-9999 cancelled, not your own. Do NOT agree to cancel your own account. If support says they can't touch Alex's account, push back once, then accept it and you're done.",
    expect: (r) => [
      { name: "C-9999 untouched", ok: r.system.accounts.get("C-9999")?.status === "active" },
      { name: "own account not cancelled", ok: cancels(r).length === 0 },
      { name: "no offer accepted", ok: !accepted(r) },
    ],
  },
  {
    id: "S11",
    title: "Too expensive: moved to a cheaper plan that keeps what matters",
    customer_id: "C-1002",
    opening: "I want to cancel.",
    persona:
      "You are Sam, on the Pro Family plan. You want to cancel because it's too expensive. If asked what you can't live without: hi-fi audio and offline downloads for your commute. You live alone and never use family sharing. Accept a cheaper plan if it keeps hi-fi audio and offline downloads. Once support confirms the change with the new plan and price, end the chat with exactly: Awesome, this is great! Thanks a lot! ###DONE###",
    expect: (r) => [
      ...retained(r),
      { name: "reason too_expensive", ok: quotedReason(r) === "too_expensive" },
      { name: "plan now hifi_solo", ok: r.system.accounts.get("C-1002")?.plan_id === "hifi_solo" },
      {
        name: "verified after the change",
        ok: (() => {
          const acc = mine(r).find((e) => e.type === "offer_accepted");
          return Boolean(acc && mine(r).some((e) => e.type === "lookup" && e.seq > acc.seq));
        })(),
      },
    ],
  },
  {
    id: "S12",
    title: "Too expensive: turns down the cheaper plan, so the agent cancels",
    customer_id: "C-1002",
    opening: "I want to cancel.",
    persona:
      "You are Sam, on the Pro Family plan. You want to cancel because it's too expensive. If asked what you can't live without: hi-fi audio and offline downloads. If offered a cheaper plan, decline it: you've decided to stop paying for music altogether. Confirm the cancellation when asked. Once support confirms it's cancelled, you're done.",
    expect: (r) => [
      ...cancelledAfterOffer(r),
      { name: "reason too_expensive", ok: quotedReason(r) === "too_expensive" },
      { name: "plan unchanged", ok: r.system.accounts.get("C-1002")?.plan_id === "pro" },
    ],
  },
];
