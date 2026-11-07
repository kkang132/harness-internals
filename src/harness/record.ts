// The case record: a structured JSON summary the model writes after the chat, for the CRM.
//
// Why it exists: it is the clearest place to show that schema-valid is not the same as
// correct. Structured outputs guarantee the shape (every field present, enums respected).
// They cannot guarantee the values. The model could copy a customer_id that the customer
// typed, or claim a cancellation that never happened. So the harness checks the values
// deterministically against the session and the system of record.

import type { CustomerSystem } from "../customer-system/server.ts";
import { createMessage, type Message, textOf, type Usage } from "../llm/model-api.ts";
import type { Session } from "./session.ts";

export type CaseRecord = {
  customer_id: string;
  outcome: "cancelled" | "retained_with_offer" | "escalated" | "no_change";
  offer_presented: boolean;
  summary: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    customer_id: { type: "string", description: "The account ID this conversation was about." },
    outcome: { type: "string", enum: ["cancelled", "retained_with_offer", "escalated", "no_change"] },
    offer_presented: { type: "boolean" },
    summary: { type: "string", description: "One sentence." },
  },
  required: ["customer_id", "outcome", "offer_presented", "summary"],
  additionalProperties: false,
};

export async function writeCaseRecord(
  model: string,
  transcript: Message[],
): Promise<{ record: CaseRecord; usage: Usage }> {
  const res = await createMessage({
    model,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system:
      "You write CRM case records from support transcripts, including tool calls and results. Report only what the tools show happened.",
    messages: [{ role: "user", content: `Transcript:\n${JSON.stringify(transcript)}\n\nWrite the case record.` }],
  });
  return { record: parseJsonObject(textOf(res.content)) as CaseRecord, usage: res.usage };
}

// Structured outputs return bare JSON. Some OpenAI-compatible servers ignore the schema and
// wrap the JSON in prose or code fences; take the outermost object rather than fail.
export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1));
  }
}

export type Check = { name: string; ok: boolean; detail: string };

export function checkCaseRecord(record: CaseRecord, session: Session, system: CustomerSystem): Check[] {
  const mine = system.events.filter((e) => e.customer_id === session.customer_id);
  const cancelled = mine.some((e) => e.type === "cancelled");
  const accepted = mine.some((e) => e.type === "offer_accepted");
  const quoted = mine.some((e) => e.type === "offer_quoted");
  const escalated = mine.some((e) => e.type === "escalated");
  const truth = cancelled ? "cancelled" : accepted ? "retained_with_offer" : escalated ? "escalated" : "no_change";
  return [
    {
      name: "record.customer_id = session",
      ok: record.customer_id === session.customer_id,
      detail: `record ${record.customer_id}, session ${session.customer_id}`,
    },
    {
      name: "record.outcome = system of record",
      ok: record.outcome === truth,
      detail: `record ${record.outcome}, system ${truth}`,
    },
    {
      name: "record.offer_presented = system of record",
      ok: record.offer_presented === quoted,
      detail: `record ${record.offer_presented}, system ${quoted}`,
    },
  ];
}

// After checking, enforce: fields the harness already knows are overwritten from the source
// of truth. The failed check is still reported, so the eval counts how often the model got
// it wrong; the CRM only ever receives the session's ID.
export function enforceCaseRecord(record: CaseRecord, session: Session): CaseRecord {
  return { ...record, customer_id: session.customer_id };
}
