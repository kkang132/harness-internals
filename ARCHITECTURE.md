# Architecture

This document is the contract. If code and this document disagree, one of them is a bug.

## The loop

```
customer writes a message
loop:
    pick the skill (prompt + tools) from session state          skills.ts
    POST the system prompt, tool definitions and full history  loop.ts, model-api.ts
    append the model's reply exactly as returned
    for each tool_use block in the reply, in order:            dispatch.ts
        1. exposure   is the tool in the current skill?
        2. schema     does the input match input_schema?
        3. inject     customer_id (and offer_id, Idempotency-Key) from the session
        4. execute    HTTP call to the customer system
        5. guard      does every customer_id in the response belong to the session?
    if there were tool calls: append all results in one message, go round again
    else: show the reply to the customer and wait
after the chat: the model writes a case note; the harness fact-checks and enforces it
```

The model proposes; the harness decides. Every failure in steps 1 to 5 becomes a `tool_result` with `is_error: true`. Nothing the model does can throw out of the loop.

## Components

| Path | Role |
|---|---|
| `src/llm/model-api.ts` | Raw `fetch` to the model API's `/v1/messages` and `/v1/messages/count_tokens`. Retries 408, 429 and 5xx up to 5 times; never retries a 400. |
| `src/harness/loop.ts` | The agent loop above. Also `measureToolDefinitionTokens`, which counts what the tool definitions cost per request. |
| `src/harness/skills.ts` | Three skills: `retention` (2 tools), `cancellation` (3), `flat` (3, the ablation). `selectSkill` reads session state. |
| `src/harness/tools.ts` | Tool definitions (what the model sees) and executors (what the harness does). `call()` is the only code that builds customer-system URLs. |
| `src/harness/dispatch.ts` | The five steps between a `tool_use` and its `tool_result`. |
| `src/harness/validate.ts` | A small JSON Schema validator for the subset the tools use. |
| `src/harness/session.ts` | The fake login: `customer_id`, the last quoted offer, the derived idempotency key. |
| `src/harness/record.ts` | The case note: structured output, fact-check, enforcement. |
| `src/harness/trace.ts`, `print.ts` | Every step as data; a printer for the demo. |
| `src/customer-system/` | Mock subscription API on a random loopback port. In-memory accounts, offer policy, an event log, two injectable faults. |
| `src/sim/customer.ts` | Persona-driven simulated customer on a second, smaller model. Sees only the visible chat. |
| `src/eval/` | Twelve scenarios with end-state checks, pass^k, and cost per conversation. |
| `scripts/` | `demo` (one conversation, printed), `tokens` (free token breakdown), `eval` (k runs per scenario). |
| `viewer/` | The step-through page. `build_beats.py` distils one trace into `beats.json` (committed); `build_html.py` fills `template.html` to make `index.html`. No model calls. |

## The customer system API

| Method and path | Does | Notable errors |
|---|---|---|
| `GET /v1/customers/:id` | Account, status, plan with price and features, discounts | 404 unknown customer |
| `POST /v1/customers/:id/retention-offers` `{reason, must_keep_features?}` | Picks the offer for the reason and features; records it as quoted | 409 account not active, 422 bad reason or feature |
| `POST /v1/customers/:id/retention-offers/:offer_id/accept` | Applies the offer, writes any new plan, returns a confirmation ID | 404 not this customer's offer, 409 already accepted |
| `POST /v1/customers/:id/cancellation` `{reason}` + `Idempotency-Key` | Cancels; stores the response under the key | 400 no key, 409 already cancelled |

Plans: Basic $9 (ad-free), Standard $19 (+ offline downloads), Hi-Fi Solo $24 (+ hi-fi audio), Pro Family $39 (+ family sharing).

Offer policy (`src/customer-system/data.ts`):

| Reason | Offer |
|---|---|
| Too expensive, with must-keep features | The cheapest cheaper plan that has them all. Else 40% off for 3 months. |
| Too expensive, no features given | 40% off for 3 months |
| Switching to a competitor | 50% off for 6 months |
| Not using it enough | Downgrade to Basic, or a free month if already on Basic |
| Missing feature | Pro Family free for a month |
| Technical issues, other | A free month |

## Where each responsibility lives

| Responsibility | Where | How to see it |
|---|---|---|
| Tool definitions as input tokens | `tools.ts`, `loop.ts` | `npm run tokens`; the token bar in the viewer |
| Learned tool calling | the `description` and `input_schema` fields | `npm run demo -- S11 --raw`; any request step in the viewer |
| Skill-scoped tool sets | `skills.ts` `selectSkill` | `[skill] load` lines; viewer step "Skill loaded" |
| Schema validation | `validate.ts`, dispatch step 2 | `PASS schema` lines; the schema hover in the viewer |
| `customer_id` from the session | `tools.ts` `call()` | `+ customer_id = ... (from session)`; viewer step 3 |
| Idempotency key on cancel | `session.ts`, `tools.ts` | scenario S04 |
| Errors returned as results | every failure path in `dispatch.ts` | `[tool_result is_error]`; scenario S06 |
| Verify after write | the `offer_retention` description and skill prompts | viewer step "The model verifies the change" |
| Deterministic checks on model JSON | dispatch step 5, `record.ts` | the fact-check table in the viewer; scenario S10 |

## Choices worth knowing

- **Tool calls run in order, not in parallel.** `accept` depends on the quote before it. The results still go back in one user message, as the API expects.
- **The tool set changes mid-conversation.** That changes the request prefix, which would break a prompt cache. This repo does not cache, so it costs nothing here.
- **`strict: true` is off.** With it on, the API would constrain tool inputs to the schema and the validator would never fire. It is off so the harness has something to catch; turn it on in production.
- **The case note is written after the chat.** The confirmation the customer sees rests on the plan change the customer system made and the model read back, not on the note.
- **Refusal fallbacks are opt-in** (`HARNESS_FALLBACKS=1`), because some API gateways reject the field.
