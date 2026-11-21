// Run one scripted conversation and print every harness step as it happens.
//
//   npm run demo -- S01            scoped skills (default)
//   npm run demo -- S01 --flat     all three tools from the first call
//   npm run demo -- S01 --raw      also print each full request body (tools and all)
//
// Spends a few cents: one conversation on the agent model, plus the simulated customer.

import { mkdirSync, writeFileSync } from "node:fs";
import { SCENARIOS } from "../src/eval/scenarios.ts";
import { DEFAULT_CONFIG, measureToolDefinitionTokens, runConversation } from "../src/harness/loop.ts";
import { colour, printEvent } from "../src/harness/print.ts";
import { provider } from "../src/llm/model-api.ts";

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--")) ?? "S01";
const mode = args.includes("--flat") ? "flat" : "scoped";
const raw = args.includes("--raw");
const scenario = SCENARIOS.find((s) => s.id === id.toUpperCase());
if (!scenario) {
  console.error(`Unknown scenario ${id}. Choose one of: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

console.log(colour.bold(`${scenario.id}: ${scenario.title}`));
console.log(
  colour.dim(
    `mode=${mode}  session customer_id=${scenario.customer_id}  faults=${JSON.stringify(scenario.faults ?? {})}`,
  ),
);

const toolDefinitionTokens = await measureToolDefinitionTokens(DEFAULT_CONFIG.agentModel);
console.log(
  colour.dim(
    `provider ${provider()}, agent ${DEFAULT_CONFIG.agentModel}, customer ${DEFAULT_CONFIG.customerModel}. Tool definition tokens per request${provider() === "anthropic" ? "" : " (estimated)"}: ${JSON.stringify(toolDefinitionTokens)}`,
  ),
);

const result = await runConversation(scenario, {
  ...DEFAULT_CONFIG,
  mode,
  toolDefinitionTokens,
  keepRequestBodies: true,
  onEvent: (e) => printEvent(e, { raw }),
});

const checks = scenario.expect(result);
console.log(`\n${colour.bold("END STATE")} (read from the customer system, not the transcript)`);
for (const k of checks) console.log(`     ${k.ok ? colour.green("PASS") : colour.red("FAIL")} ${k.name}`);
const input = result.calls.reduce((s, x) => s + x.input_tokens, 0);
const toolTok = result.calls.reduce((s, x) => s + x.tool_definition_tokens, 0);
console.log(
  `\n${colour.bold("TOKENS")} ${result.calls.length} calls, ${input} input tokens, of which ~${toolTok} were tool definitions (${Math.round((100 * toolTok) / Math.max(1, input))}%)`,
);
console.log(colour.dim(`stopped by: ${result.stoppedBy}`));

mkdirSync("results/traces", { recursive: true });
const file = `results/traces/${scenario.id}-${mode}-${Date.now()}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      scenario: scenario.id,
      mode,
      checks,
      spans: result.spans,
      events: result.trace,
      systemEvents: result.system.events,
    },
    null,
    2,
  ),
);
console.log(colour.dim(`trace: ${file}`));
