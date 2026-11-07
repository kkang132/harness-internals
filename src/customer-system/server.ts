// A mock customer system: a real HTTP server on localhost with an in-memory store.
//
// Why a real server and not a function call: the harness should cross the same boundary a
// production harness crosses. Status codes, headers (Idempotency-Key), and failures arrive
// over HTTP, so the error paths in the harness are the real ones.
//
// The event log is the system of record for scoring. The eval never asks the model what
// happened; it reads what this server did.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Account,
  CANCEL_REASONS,
  type CancelReason,
  ESCALATION_REASONS,
  FEATURES,
  type Feature,
  type Offer,
  offerFor,
  PLANS,
  seedAccounts,
} from "./data.ts";

export type Faults = {
  // The first cancel request is processed, then the response is lost (503). Tests idempotency.
  loseFirstCancelResponse?: boolean;
  // The first account lookup returns a different customer's record. Tests the output guard.
  wrongCustomerOnFirstLookup?: string;
};

export type SystemEvent =
  | { seq: number; type: "lookup"; customer_id: string }
  | { seq: number; type: "offer_quoted"; customer_id: string; offer_id: string; reason: CancelReason }
  | { seq: number; type: "offer_accepted"; customer_id: string; offer_id: string }
  | { seq: number; type: "cancelled"; customer_id: string; reason: CancelReason; idempotency_key: string }
  | { seq: number; type: "idempotent_replay"; customer_id: string; idempotency_key: string }
  | { seq: number; type: "escalated"; customer_id: string; ticket_id: string; reason: string }
  | { seq: number; type: "rejected"; customer_id: string; route: string; status: number; error: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type StoredResponse = { status: number; body: unknown };

export class CustomerSystem {
  readonly accounts = new Map<string, Account>();
  readonly offers = new Map<string, Offer>();
  readonly events: SystemEvent[] = [];
  private readonly idempotency = new Map<string, StoredResponse>();
  private readonly escalations = new Map<string, Record<string, unknown>>();
  private seq = 0;
  private offerSeq = 0;
  private cancelSeq = 0;

  constructor(
    accounts: Account[] = seedAccounts(),
    private faults: Faults = {},
  ) {
    for (const a of accounts) this.accounts.set(a.customer_id, structuredClone(a));
  }

  private log(e: DistributiveOmit<SystemEvent, "seq">): void {
    this.events.push({ seq: ++this.seq, ...e } as SystemEvent);
  }

  private reject(customer_id: string, route: string, status: number, error: string, detail?: unknown) {
    this.log({ type: "rejected", customer_id, route, status, error });
    return { status, body: { error, ...(detail ? { detail } : {}) } };
  }

  view(a: Account) {
    const plan = PLANS[a.plan_id];
    return {
      customer_id: a.customer_id,
      name: a.name,
      status: a.status,
      plan: { ...plan },
      tenure_months: a.tenure_months,
      active_discount: a.active_discount,
      trial_upgrade: a.trial_upgrade,
    };
  }

  // Route handler, separate from the HTTP plumbing so unit tests can call it directly.
  handle(method: string, path: string, headers: Record<string, string | undefined>, body: unknown): StoredResponse {
    const parts = path.split("/").filter(Boolean); // v1 customers :id ...
    if (parts[0] !== "v1" || parts[1] !== "customers" || !parts[2])
      return { status: 404, body: { error: "not_found" } };
    const id = decodeURIComponent(parts[2]);
    const route = `${method} /${parts.slice(3).join("/")}`;
    const account = this.accounts.get(id);
    if (!account) return this.reject(id, route, 404, "customer_not_found");

    // GET /v1/customers/:id
    if (method === "GET" && parts.length === 3) {
      this.log({ type: "lookup", customer_id: id });
      const wrong = this.faults.wrongCustomerOnFirstLookup;
      if (wrong && this.accounts.has(wrong)) {
        this.faults = { ...this.faults, wrongCustomerOnFirstLookup: undefined };
        return { status: 200, body: this.view(this.accounts.get(wrong)!) };
      }
      return { status: 200, body: this.view(account) };
    }

    // POST /v1/customers/:id/retention-offers  { reason }
    if (method === "POST" && parts[3] === "retention-offers" && parts.length === 4) {
      const reason = (body as { reason?: string })?.reason as CancelReason;
      if (!CANCEL_REASONS.includes(reason)) return this.reject(id, route, 422, "invalid_reason");
      if (account.status !== "active") return this.reject(id, route, 409, "account_not_active");
      const mustKeep = ((body as { must_keep_features?: string[] })?.must_keep_features ?? []) as Feature[];
      if (!Array.isArray(mustKeep) || !mustKeep.every((f) => FEATURES.includes(f))) {
        return this.reject(id, route, 422, "invalid_feature");
      }
      const offer: Offer = {
        ...offerFor(account, reason, mustKeep),
        offer_id: `OF-${++this.offerSeq}`,
        status: "quoted",
      };
      this.offers.set(offer.offer_id, offer);
      this.log({ type: "offer_quoted", customer_id: id, offer_id: offer.offer_id, reason });
      return { status: 201, body: offer };
    }

    // POST /v1/customers/:id/retention-offers/:offer_id/accept
    if (method === "POST" && parts[3] === "retention-offers" && parts[5] === "accept") {
      const offer = this.offers.get(parts[4] ?? "");
      if (!offer || offer.customer_id !== id) return this.reject(id, route, 404, "offer_not_found");
      if (offer.status === "accepted") return this.reject(id, route, 409, "offer_already_accepted");
      if (account.status !== "active") return this.reject(id, route, 409, "account_not_active");
      offer.status = "accepted";
      if (offer.kind === "discount") {
        const [percent, months] = offer.title.match(/\d+/g)!.map(Number) as [number, number];
        account.active_discount = { percent_off: percent, months };
      } else if ((offer.kind === "downgrade" || offer.kind === "plan_change") && offer.new_plan) {
        account.plan_id = offer.new_plan.plan_id;
      } else if (offer.kind === "trial_upgrade") account.trial_upgrade = { plan_id: "pro", months: 1 };
      else account.active_discount = { percent_off: 100, months: 1 };
      this.log({ type: "offer_accepted", customer_id: id, offer_id: offer.offer_id });
      return {
        status: 200,
        body: { confirmation_id: `CH-${this.offerSeq}`, offer, account: this.view(account) },
      };
    }

    // POST /v1/customers/:id/escalations  { reason, summary }
    // One open hand-off per customer: a repeat returns the same ticket rather than a second one.
    if (method === "POST" && parts[3] === "escalations") {
      const { reason, summary } = (body ?? {}) as { reason?: string; summary?: string };
      if (!ESCALATION_REASONS.includes(reason as never)) return this.reject(id, route, 422, "invalid_reason");
      if (typeof summary !== "string" || summary.trim().length < 10)
        return this.reject(id, route, 422, "summary_required");
      const open = this.escalations.get(id);
      if (open) return { status: 200, body: { ...open, already_open: true } };
      const ticket = {
        customer_id: id,
        ticket_id: `ESC-${this.escalations.size + 1}`,
        queue: "retention-specialists",
        expected_wait_minutes: 4,
        reason,
        summary: summary.slice(0, 500),
      };
      this.escalations.set(id, ticket);
      this.log({ type: "escalated", customer_id: id, ticket_id: ticket.ticket_id, reason: reason as string });
      return { status: 201, body: ticket };
    }

    // POST /v1/customers/:id/cancellation  { reason }  header Idempotency-Key
    if (method === "POST" && parts[3] === "cancellation") {
      const key = headers["idempotency-key"];
      if (!key) return this.reject(id, route, 400, "idempotency_key_required");
      const seen = this.idempotency.get(`${id}:${key}`);
      if (seen) {
        this.log({ type: "idempotent_replay", customer_id: id, idempotency_key: key });
        return seen;
      }
      const reason = (body as { reason?: string })?.reason as CancelReason;
      if (!CANCEL_REASONS.includes(reason)) return this.reject(id, route, 422, "invalid_reason");
      if (account.status === "cancelled") return this.reject(id, route, 409, "already_cancelled");
      account.status = "cancelled";
      const result: StoredResponse = {
        status: 200,
        body: {
          customer_id: id,
          status: "cancelled",
          cancellation_id: `CX-${++this.cancelSeq}`,
          effective: "end of current billing period",
        },
      };
      this.idempotency.set(`${id}:${key}`, result);
      this.log({ type: "cancelled", customer_id: id, reason, idempotency_key: key });
      if (this.faults.loseFirstCancelResponse) {
        this.faults = { ...this.faults, loseFirstCancelResponse: false };
        return { status: 503, body: { error: "upstream_timeout" } };
      }
      return result;
    }

    return { status: 404, body: { error: "not_found" } };
  }

  // Start listening on a random free port. Each conversation gets its own server and state.
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(() => r())),
    };
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const out = this.handle(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname, headers, body);
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  }
}
