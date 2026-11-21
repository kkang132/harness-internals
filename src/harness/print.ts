// Pretty-printer for trace events, so a single conversation reads like a lab notebook.

import type { TraceEvent } from "./trace.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}...` : s);

export function printEvent(e: TraceEvent, opts: { raw?: boolean } = {}): void {
  switch (e.kind) {
    case "customer":
      console.log(`\n${c.bold("CUSTOMER")}  ${e.text}`);
      break;
    case "agent":
      console.log(`${c.bold("AGENT")}     ${e.text}`);
      break;
    case "skill":
      console.log(c.magenta(`  [skill] load '${e.skill}' -> tools [${e.tools.join(", ")}]  (${e.reason})`));
      break;
    case "request":
      console.log(
        c.cyan(`  -> POST /v1/messages #${e.call}  skill=${e.skill}  tools=${e.tools.length}  messages=${e.messages}`),
      );
      if (opts.raw && e.body) console.log(c.dim(JSON.stringify(e.body, null, 2)));
      break;
    case "response":
      console.log(
        c.cyan(
          `  <- ${e.stop_reason}  input_tokens=${e.input_tokens} (tool definitions ~${e.tool_definition_tokens})  output_tokens=${e.output_tokens}${e.duration_ms !== undefined ? `  (${e.duration_ms}ms)` : ""}`,
        ),
      );
      break;
    case "thinking":
      console.log(c.dim(`     thinking: ${clip(e.text.replace(/\s+/g, " "), 300)}`));
      break;
    case "tool_call":
      console.log(c.yellow(`  [tool_use] ${e.name}(${JSON.stringify(e.input)})`));
      break;
    case "check":
      console.log(`     ${e.ok ? c.green("PASS") : c.red("FAIL")} ${e.name}: ${e.detail}`);
      break;
    case "inject":
      console.log(c.dim(`     + ${e.field} = ${e.value}  (from ${e.source})`));
      break;
    case "http":
      console.log(
        c.dim(
          `     ${e.method} ${e.path} -> ${e.status}${e.idempotency_key ? `  [Idempotency-Key ${e.idempotency_key}]` : ""}`,
        ),
      );
      break;
    case "tool_result":
      console.log(
        `     ${e.is_error ? c.red("[tool_result is_error]") : c.green("[tool_result]")} ${c.dim(clip(e.content))}`,
      );
      break;
    case "note":
      console.log(c.yellow(`     note: ${e.text}`));
      break;
    case "record":
      console.log(`\n${c.bold("CASE RECORD")} ${JSON.stringify(e.record)}`);
      for (const k of e.checks) console.log(`     ${k.ok ? c.green("PASS") : c.red("FAIL")} ${k.name}: ${k.detail}`);
      break;
  }
}

export { c as colour };
