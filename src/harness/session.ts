// The fake session: who the customer is, established before the model sees anything.
//
// Why this matters: in a real product the customer has logged in. Their ID comes from the
// auth layer, not from the conversation. So the ID is never a tool parameter. The model
// cannot type it, mistype it, or be talked into typing someone else's. The harness adds it
// to every request on the way out and checks it on every response on the way back.

import { createHash, randomUUID } from "node:crypto";
import type { CancelReason } from "../customer-system/data.ts";

export type Session = {
  session_id: string;
  customer_id: string; // from "auth", never from the model
  quoted_offer: { offer_id: string; reason: CancelReason } | null;
};

export function newSession(customer_id: string): Session {
  return { session_id: randomUUID(), customer_id, quoted_offer: null };
}

// One cancellation intent per session. Any retry of the cancel call, by the harness or by
// the model calling the tool again, carries the same key, so the customer system processes
// it once. Derived, not random, so it survives a harness restart mid-conversation.
export function cancelIdempotencyKey(session: Session): string {
  return createHash("sha256").update(`${session.session_id}:${session.customer_id}:cancel`).digest("hex").slice(0, 32);
}
