# AGENTS.md

Guidance for AI agents in this repository.

## Rules (never break these)

- Never add `customer_id`, `offer_id` or an idempotency key to a tool's `input_schema`. Those come from the session.
- Never call the customer system from anywhere but `call()` in `src/harness/tools.ts`.
- Never call a model from anywhere but `src/llm/`. Provider differences live in an adapter there, never in the harness.
- Never let a provider adapter drop a tool call or a tool result. Its tests must cover both directions.
- Never let a tool failure throw out of the loop. Every failure becomes a `tool_result` with `is_error: true`.
- Never edit or rebuild a message already in the history. Append the API's `content` exactly as returned.
- Never score a scenario from the transcript when the customer system's event log can answer it.
- Never add a runtime dependency. The point is that the harness is visible; `fetch` is enough.
- Never let a tool appear in a skill before its precondition holds. `cancel_subscription` stays out until an offer is quoted.
- Never render model text as HTML in the viewer. Pass every string through `esc()`.
- Never name a model vendor in the viewer. The model is "the model API" and `LLM_1`.
- Never commit `.env` or anything under `results/`. Commit `viewer/beats.json`, which is derived and holds no secrets.
- Never add a claim to SECURITY.md's controls table without a test that proves it, or a note saying there is none.

## Working

- Run `npm run check` (lint, typecheck, tests) and keep it green. Install with `npm ci`.
- Every file opens with a comment: what it is for, and why.
- Write for a reader who knows neither TypeScript nor agent harnesses. Define new terms in [GLOSSARY.md](./GLOSSARY.md).
- `npm run demo` and `npm run eval` spend money; `eval` prints an upper bound first. `npm run tokens`, `npm run check` and `npm run viewer` do not.
- After recording a new demo trace, run `npm run viewer:beats` then `npm run viewer`.
- Prose: short declarative sentences, Oxford commas, no em-dashes.

## Proofs

Deterministic, no model calls. Run before and after any change.

```bash
# 1. lint, typecheck, 53 unit tests (schemas, skills, customer system, dispatch, case note, eval arithmetic, adapter)
npm run check

# 2. no tool definition mentions customer_id, offer_id or an idempotency key
npx vitest run -t "never mention customer_id"

# 3. only tools.ts talks to the customer system, and only src/llm/ talks to a model
grep -rln "/v1/customers" src/harness | grep -v "src/harness/tools.ts" && echo "BYPASS" || echo "ok"
grep -rln "fetch(" src | grep -vE "^src/llm/|^src/harness/tools.ts$" && echo "BYPASS" || echo "ok"

# 4. the viewer names no model vendor
grep -ciE "claude|anthropic|opus|sonnet|haiku" viewer/index.html viewer/beats.json | grep -v ":0$" && echo "NAMED" || echo "ok"

# 5. no em-dashes in prose or code
grep -rln $'\u2014' --include='*.md' --include='*.ts' --include='*.html' --include='*.py' . --exclude-dir=node_modules --exclude-dir=results && echo "EM-DASH" || echo "ok"

# 6. nothing local or secret is tracked by git
git ls-files | grep -E "^results/|(^|/)\.env$" && echo "TRACKED: remove it" || echo "ok"
```
