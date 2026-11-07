// The dispatcher: what happens between "the model asked for a tool" and "the model sees a result".
//
// Five steps, each a harness responsibility, each traced:
//   1. exposure   the tool must be in the current skill's tool set
//   2. schema     the input must match the tool's input_schema
//   3. inject     customer_id (and, for cancel, an Idempotency-Key) come from the session
//   4. execute    an HTTP call to the customer system
//   5. guard      every customer_id in the response must be the session's
// Any failure becomes a tool_result with is_error: true. The model reads the error and can
// recover. Nothing throws out of the loop because the model made a mistake.

import type { ToolResultBlock, ToolUseBlock } from "../llm/model-api.ts";
import type { Skill } from "./skills.ts";
import { EXECUTORS, TOOL_DEFINITIONS, type ToolContext, type ToolName } from "./tools.ts";
import { validate } from "./validate.ts";

export async function dispatch(block: ToolUseBlock, skill: Skill, ctx: ToolContext): Promise<ToolResultBlock> {
  const { trace } = ctx;
  trace.emit({ kind: "tool_call", id: block.id, name: block.name, input: block.input });
  const result = (content: unknown, is_error: boolean): ToolResultBlock => {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    trace.emit({ kind: "tool_result", id: block.id, is_error, content: text });
    return { type: "tool_result", tool_use_id: block.id, content: text, ...(is_error ? { is_error } : {}) };
  };

  // 1. Exposure. The API only lets the model call tools we sent, but a harness should not trust that.
  const exposed = (skill.tools as string[]).includes(block.name);
  trace.emit({ kind: "check", name: "exposure", ok: exposed, detail: `${block.name} in skill '${skill.name}'` });
  if (!exposed) return result({ error: `tool '${block.name}' is not available right now` }, true);
  const name = block.name as ToolName;

  // 2. Schema.
  const errors = validate(TOOL_DEFINITIONS[name].input_schema, block.input);
  trace.emit({
    kind: "check",
    name: "schema",
    ok: errors.length === 0,
    detail: errors.length === 0 ? "input matches input_schema" : errors.map((e) => `${e.path} ${e.message}`).join("; "),
  });
  if (errors.length > 0) {
    return result({ error: "invalid tool input", problems: errors.map((e) => `${e.path} ${e.message}`) }, true);
  }

  // 3 and 4. Inject and execute (see tools.ts).
  let outcome: Awaited<ReturnType<(typeof EXECUTORS)[ToolName]>>;
  try {
    outcome = await EXECUTORS[name](ctx, block.input as Record<string, unknown>);
  } catch (err) {
    return result({ error: `tool failed: ${(err as Error).message}` }, true);
  }

  // 5. Output guard, applied to successes and errors alike.
  const foreign = foreignCustomerIds(outcome.data, ctx.session.customer_id);
  trace.emit({
    kind: "check",
    name: "output customer_id",
    ok: foreign.length === 0,
    detail:
      foreign.length === 0 ? `all customer_id fields = ${ctx.session.customer_id}` : `found ${foreign.join(", ")}`,
  });
  if (foreign.length > 0) {
    // Withhold the data entirely: the model must never see another customer's record.
    return result(
      { error: "integrity check failed: the customer system returned the wrong account; data withheld. Retry once." },
      true,
    );
  }

  return outcome.ok ? result(outcome.data, false) : result({ error: outcome.error, detail: outcome.data }, true);
}

// Every customer_id anywhere in a JSON value that is not the expected one.
export function foreignCustomerIds(value: unknown, expected: string): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (k === "customer_id" && child !== expected) found.add(String(child));
        walk(child);
      }
    }
  };
  walk(value);
  return [...found];
}
