// What does each tool definition cost? Free to run: uses the token-counting endpoint only.
//
//   npm run tokens
//
// Counts one fixed request ("Hi", the retention prompt) with 0, 1, 2 and 3 tools. The first
// tool costs more than the rest because adding any tool also adds the API's own tool-use
// instructions to the prompt.

import { DEFAULT_CONFIG } from "../src/harness/loop.ts";
import { ALL_SKILLS } from "../src/harness/skills.ts";
import { TOOL_DEFINITIONS, type ToolName } from "../src/harness/tools.ts";
import { countTokens } from "../src/llm/model-api.ts";

const model = DEFAULT_CONFIG.agentModel;
const system = ALL_SKILLS.retention.prompt;
const messages = [{ role: "user" as const, content: "Hi" }];
const order: ToolName[] = ["get_plan", "offer_retention", "cancel_subscription"];

console.log(`model ${model}, system prompt = retention skill, one user message "Hi"\n`);
console.log("tools in request                              input_tokens   added");
let prev = await countTokens({ model, system, messages });
console.log(`${"(none)".padEnd(46)}${String(prev).padStart(12)}`);
for (let i = 1; i <= order.length; i++) {
  const tools = order.slice(0, i).map((t) => TOOL_DEFINITIONS[t]);
  const n = await countTokens({ model, system, messages, tools });
  console.log(`${order.slice(0, i).join(", ").padEnd(46)}${String(n).padStart(12)}${`+${n - prev}`.padStart(8)}`);
  prev = n;
}

console.log("\nper skill (tool definitions + tool-use preamble, per request):");
for (const skill of Object.values(ALL_SKILLS)) {
  const base = { model, system: skill.prompt, messages };
  const diff =
    (await countTokens({ ...base, tools: skill.tools.map((t) => TOOL_DEFINITIONS[t]) })) - (await countTokens(base));
  console.log(`  ${skill.name.padEnd(13)} ${skill.tools.length} tools  ${diff} tokens`);
}
