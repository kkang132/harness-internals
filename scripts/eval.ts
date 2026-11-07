// Run the ten scenarios k times each and report pass^k, token use and case-record checks.
//
//   npm run eval                       scoped skills, k=5
//   npm run eval -- --mode flat        all tools always (the ablation)
//   npm run eval -- --mode both        both, side by side
//   npm run eval -- --k 2 --only S01,S04
//
// Spends money. Prints an upper bound before starting.

import { mkdirSync, writeFileSync } from "node:fs";
import { conversationCostUsd, median } from "../src/eval/cost.ts";
import { SCENARIOS } from "../src/eval/scenarios.ts";
import { meanPassHatK } from "../src/eval/score.ts";
import {
  type ConversationResult,
  DEFAULT_CONFIG,
  measureToolDefinitionTokens,
  runConversation,
} from "../src/harness/loop.ts";
import { colour } from "../src/harness/print.ts";
import type { Mode } from "../src/harness/skills.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const k = Number(flag("k") ?? 5);
const modeArg = flag("mode") ?? "scoped";
const modes: Mode[] = modeArg === "both" ? ["scoped", "flat"] : [modeArg as Mode];
const only = flag("only")?.toUpperCase().split(",");
const concurrency = Number(flag("concurrency") ?? 5);
const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));

// Upper bound: measured S01 used ~13k input / ~0.5k output tokens on the agent model.
// Assume 2x that per conversation, at Claude Opus 5.5 list prices ($4 / $20 per million).
const runs = scenarios.length * k * modes.length;
const bound = runs * ((26_000 * 4 + 1_500 * 20) / 1e6);
console.log(
  `${runs} conversations (${scenarios.length} scenarios x k=${k} x ${modes.join("+")}). Upper bound ~$${bound.toFixed(2)}.`,
);

const toolDefinitionTokens = await measureToolDefinitionTokens(DEFAULT_CONFIG.agentModel);

type Row = {
  mode: Mode;
  scenario: string;
  run: number;
  pass: boolean;
  failed: string[];
  recordOk: boolean;
  recordFailed: string[];
  calls: number;
  input_tokens: number;
  output_tokens: number;
  tool_definition_tokens: number;
  stoppedBy: string;
  cost_usd: number;
  error?: string;
};

const jobs = modes.flatMap((mode) =>
  scenarios.flatMap((s) => Array.from({ length: k }, (_, run) => ({ mode, s, run }))),
);
const rows: Row[] = [];
const outDir = `results/eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(`${outDir}/traces`, { recursive: true });

let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { mode, s, run } = jobs[next++]!;
    let r: ConversationResult | undefined;
    try {
      r = await runConversation(s, { ...DEFAULT_CONFIG, mode, toolDefinitionTokens });
      const checks = s.expect(r);
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      const recordFailed = r.recordChecks.filter((c) => !c.ok).map((c) => c.name);
      rows.push({
        mode,
        scenario: s.id,
        run,
        pass: failed.length === 0,
        failed,
        recordOk: recordFailed.length === 0,
        recordFailed,
        calls: r.calls.length,
        input_tokens: r.calls.reduce((a, c) => a + c.input_tokens, 0),
        output_tokens: r.calls.reduce((a, c) => a + c.output_tokens, 0),
        tool_definition_tokens: r.calls.reduce((a, c) => a + c.tool_definition_tokens, 0),
        stoppedBy: r.stoppedBy,
        cost_usd: conversationCostUsd(r),
      });
      writeFileSync(
        `${outDir}/traces/${mode}-${s.id}-${run}.json`,
        JSON.stringify({ checks, chat: r.chat, events: r.trace, systemEvents: r.system.events }, null, 2),
      );
    } catch (err) {
      rows.push({
        mode,
        scenario: s.id,
        run,
        pass: false,
        failed: ["harness error"],
        recordOk: false,
        recordFailed: [],
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        tool_definition_tokens: 0,
        stoppedBy: "error",
        cost_usd: 0,
        error: (err as Error).message,
      });
    }
    const last = rows.at(-1)!;
    process.stdout.write(`${last.pass ? colour.green(".") : colour.red("x")}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log("\n");

const lines: string[] = [];
const out = (s = "") => {
  lines.push(s);
  console.log(s);
};

for (const mode of modes) {
  const mine = rows.filter((r) => r.mode === mode);
  out(`## mode: ${mode}`);
  out();
  out(`| scenario | passes | pass^1 | pass^${k} | record ok | mean calls | mean input tok | failures |`);
  out("|---|---|---|---|---|---|---|---|");
  const per: { passes: number; runs: number }[] = [];
  for (const s of scenarios) {
    const rs = mine.filter((r) => r.scenario === s.id);
    const passes = rs.filter((r) => r.pass).length;
    per.push({ passes, runs: rs.length });
    const fails = [...new Set(rs.flatMap((r) => [...r.failed, ...(r.error ? [r.error.slice(0, 60)] : [])]))].join("; ");
    out(
      `| ${s.id} ${s.title} | ${passes}/${rs.length} | ${(passes / rs.length).toFixed(2)} | ${passes === rs.length ? "1" : "0"} | ${rs.filter((r) => r.recordOk).length}/${rs.length} | ${(avg(rs.map((r) => r.calls))).toFixed(1)} | ${Math.round(avg(rs.map((r) => r.input_tokens)))} | ${fails} |`,
    );
  }
  const calls = sum(mine.map((r) => r.calls));
  const input = sum(mine.map((r) => r.input_tokens));
  const toolTok = sum(mine.map((r) => r.tool_definition_tokens));
  out();
  out(`pass^1 = ${meanPassHatK(per, 1).toFixed(3)}   pass^${k} = ${meanPassHatK(per, k).toFixed(3)}`);
  out(
    `tokens: ${calls} agent calls, ${input} input tokens (${Math.round(input / Math.max(1, calls))} per call), of which ${toolTok} tool definitions (${Math.round(toolTok / Math.max(1, calls))} per call, ${((100 * toolTok) / Math.max(1, input)).toFixed(0)}%)`,
  );
  out(`case-record checks passed: ${mine.filter((r) => r.recordOk).length}/${mine.length}`);
  const resolved = mine.filter((r) => r.pass).map((r) => r.cost_usd);
  out(
    `p50 cost to resolve: $${median(resolved).toFixed(4)} over ${resolved.length} resolved of ${mine.length} runs (agent model only)`,
  );
  out();
}

writeFileSync(`${outDir}/rows.json`, JSON.stringify(rows, null, 2));
writeFileSync(`${outDir}/summary.md`, `${lines.join("\n")}\n`);
console.log(colour.dim(`saved ${outDir}/summary.md, rows.json, traces/`));

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}
function avg(xs: number[]) {
  return xs.length ? sum(xs) / xs.length : 0;
}
