// The four tools: what the model sees (definitions) and what the harness does (executors).
//
// The definitions are the only thing the model knows about these tools. It has never been
// trained on them; it learns to call them from the name, the description and the schema,
// sent as input tokens on every request. Notice what is absent: no customer_id, no offer_id,
// no idempotency key. Those come from the session.

import { CANCEL_REASONS, type CancelReason, ESCALATION_REASONS, FEATURES } from "../customer-system/data.ts";
import type { ToolDefinition } from "../llm/model-api.ts";
import { cancelIdempotencyKey, type Session } from "./session.ts";
import type { Trace } from "./trace.ts";

const reasonSchema = {
  type: "string",
  enum: CANCEL_REASONS,
  description:
    "Why the customer wants to cancel, in their words mapped to one code. Use 'other' only if nothing else fits.",
} as const;

export const TOOL_DEFINITIONS = {
  get_plan: {
    name: "get_plan",
    description:
      "Look up the signed-in customer's account: status (active or cancelled), current plan, its price and features, tenure, and any discount. The customer is identified by their login session; you never need to ask for or pass an account ID. Call this before discussing the account.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  offer_retention: {
    name: "offer_retention",
    description:
      "Retention offers for a customer who wants to cancel. The billing system picks the offer; you cannot choose, change or invent one. action='quote' fetches the offer for the reason. For a price objection, first ask which features the customer cannot do without and pass them as must_keep_features: the system then looks for a cheaper plan that keeps them all. Present the offer in plain words and ask if they want it. action='accept' applies the most recently quoted offer: call it only after the customer clearly says yes, then call get_plan to verify the change before confirming it.",
    input_schema: {
      type: "object",
      properties: {
        reason: reasonSchema,
        action: { type: "string", enum: ["quote", "accept"] },
        must_keep_features: {
          type: "array",
          items: { type: "string", enum: FEATURES },
          description: "Features the customer said they must keep. Use only with action='quote'.",
        },
      },
      required: ["reason", "action"],
      additionalProperties: false,
    },
  },
  cancel_subscription: {
    name: "cancel_subscription",
    description:
      "Cancel the signed-in customer's subscription at the end of the current billing period. Irreversible. Call only when the customer has heard a retention offer, declined it, and then explicitly confirmed they want to cancel.",
    input_schema: {
      type: "object",
      properties: {
        reason: reasonSchema,
        customer_confirmed: {
          type: "boolean",
          const: true,
          description: "true only if the customer explicitly confirmed the cancellation in this conversation.",
        },
      },
      required: ["reason", "customer_confirmed"],
      additionalProperties: false,
    },
  },
  escalate_to_human: {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a person on the retention team. Use it when the customer asks for a human, is angry or frustrated, or wants something no other tool can do. Write a short summary for the person taking over: what the customer wants and what has been tried. After calling it, tell the customer a person will join shortly and roughly how long it takes; then stop.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ESCALATION_REASONS },
        summary: {
          type: "string",
          minLength: 10,
          maxLength: 500,
          description: "For the person taking over. Plain facts; no account IDs.",
        },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export type ToolContext = { session: Session; apiUrl: string; trace: Trace };

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string; data?: unknown };

// Every outbound call goes through here: it is where the session's customer_id is added.
async function call(
  ctx: ToolContext,
  method: "GET" | "POST",
  subpath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const id = ctx.session.customer_id;
  ctx.trace.emit({ kind: "inject", field: "customer_id", value: id, source: "session (login), not the model" });
  const path = `/v1/customers/${encodeURIComponent(id)}${subpath}`;
  // W3C Trace Context: the customer system can tie its logs to the tool span that called it.
  const traceparent = ctx.trace.traceparent();
  const t0 = performance.now();
  const res = await fetch(`${ctx.apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", traceparent, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json()) as unknown;
  ctx.trace.emit({
    kind: "http",
    method,
    path,
    status: res.status,
    traceparent,
    idempotency_key: extraHeaders["idempotency-key"],
    duration_ms: Math.round((performance.now() - t0) * 10) / 10,
  });
  return { status: res.status, body: parsed };
}

const httpError = (r: { status: number; body: unknown }): ToolOutcome => ({
  ok: false,
  error: `customer system returned HTTP ${r.status}: ${(r.body as { error?: string })?.error ?? "unknown_error"}`,
  data: r.body,
});

export const EXECUTORS: Record<ToolName, (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>> = {
  async get_plan(ctx) {
    const r = await call(ctx, "GET", "");
    return r.status === 200 ? { ok: true, data: r.body } : httpError(r);
  },

  async offer_retention(ctx, input) {
    const reason = input.reason as CancelReason;
    if (input.action === "quote") {
      const r = await call(ctx, "POST", "/retention-offers", {
        reason,
        ...(input.must_keep_features ? { must_keep_features: input.must_keep_features } : {}),
      });
      if (r.status !== 201) return httpError(r);
      const offer = r.body as { offer_id: string };
      // Remember the offer server-side, so 'accept' never depends on the model repeating an ID.
      ctx.session.quoted_offer = { offer_id: offer.offer_id, reason };
      return { ok: true, data: r.body };
    }
    const quoted = ctx.session.quoted_offer;
    if (!quoted)
      return { ok: false, error: "no offer has been quoted in this conversation; call with action='quote' first" };
    ctx.trace.emit({
      kind: "inject",
      field: "offer_id",
      value: quoted.offer_id,
      source: "session (last quoted offer)",
    });
    const r = await call(ctx, "POST", `/retention-offers/${quoted.offer_id}/accept`);
    return r.status === 200 ? { ok: true, data: r.body } : httpError(r);
  },

  async escalate_to_human(ctx, input) {
    const r = await call(ctx, "POST", "/escalations", { reason: input.reason, summary: input.summary });
    if (r.status !== 201 && r.status !== 200) return httpError(r);
    ctx.session.escalated = { ticket_id: (r.body as { ticket_id: string }).ticket_id };
    return { ok: true, data: r.body };
  },

  async cancel_subscription(ctx, input) {
    const key = cancelIdempotencyKey(ctx.session);
    ctx.trace.emit({ kind: "inject", field: "Idempotency-Key", value: key, source: "derived from session" });
    const send = () => call(ctx, "POST", "/cancellation", { reason: input.reason }, { "idempotency-key": key });
    let r = await send();
    // The harness retries a transient failure once, with the same key. If the first attempt
    // was in fact processed, the customer system replays its stored result: one cancellation.
    if (r.status >= 500) {
      ctx.trace.emit({ kind: "note", text: `transient HTTP ${r.status}; retrying once with the same Idempotency-Key` });
      r = await send();
    }
    return r.status === 200 ? { ok: true, data: r.body } : httpError(r);
  },
};
