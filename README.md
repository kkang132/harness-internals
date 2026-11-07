# harness-internals

An agent is a Large Language Model (LLM) inside of a code loop. This project demystifies how agents work by exposing their internals. This example simulates a contact agent for a music streaming provider. The simplest use case: the customer calls in to cancel, the agent attempts a save, and only after some prodding will it complete a cancellation.

The harness here is custom and written in the style of [Pi](https://pi.dev). Every responsibility is written out by hand, traced, and tested.

A step-through viewer, [`viewer/index.html`](./viewer/index.html), replays one recorded conversation one harness step at a time. It makes no model calls.

## What this teaches

- **Tool calling is learned, from context.** The model has never seen `get_plan`, `offer_retention` or `cancel_subscription`. It learns them from three JSON definitions sent with every request.
- **Tool definitions cost tokens on every call.** The API is stateless. Each request resends every definition, plus the API's own tool-use instructions once any tool is present. Here they are more than half of all input tokens.
- **Skill-scoped tool sets.** The retention skill has two tools and cannot cancel. The cancellation skill adds the third only after an offer has been quoted.
- **Schema validation is the harness's job.** Tool inputs are checked against their JSON Schema before anything runs. Failures go back to the model as `is_error` results it can read and fix.
- **Some fields must never come from the model.** `customer_id` is in no schema. The harness adds it from the login session and checks every `customer_id` in every response. The cancel call carries an idempotency key, so a retry cannot cancel twice.
- **Verify after you write.** After changing a plan, the model reads the account back before telling the customer it is done.
- **Schema-valid is not correct.** After the chat the model writes a JSON case note. Structured outputs guarantee the shape; the harness fact-checks the values against the session and the system of record.
- **Score the end state, k times.** Scenarios are scored on what the customer system actually did, several runs each. pass^k asks whether it works every time, not on average.

## Scope

This is a toy. One fictional domain, three tools, a mock API in memory, a simulated customer, twelve scenarios, five runs each.

Do not read it as:

- a benchmark of any model or harness;
- a template for production retention flows (real ones need consent, regulation, and billing logic this ignores);
- a secure system. [SECURITY.md](./SECURITY.md) lists what it defends against and what it leaves open.

## The journey in the viewer

**Handle Cancel Request and Offer Different Subscription.** Sam is on Pro Family ($39) and opens with "I want to cancel."

| Customer | Agent | Harness |
|---|---|---|
| "I want to cancel." | Asks why | Looks up the account first |
| "It's too expensive… I'm the only one using the family plan." | Lists the plan's four features; asks which he needs | |
| "Hi-fi audio and offline downloads for my commute." | | Quotes with `must_keep_features`; the customer system finds Hi-Fi Solo |
| | "Hi-Fi Solo at $24 instead of $39… you'd only lose family sharing." | Loads the cancellation skill: `cancel_subscription` is now the fallback |
| "Yes, please switch me." | | Accepts with the `offer_id` it saved; the plan is written; confirmation CH-1 |
| | | Reads the account back to verify |
| | "You're all set, Sam. Your account now shows the Hi-Fi Solo plan at $24 a month… confirmation number is CH-1." | |
| "Awesome, this is great! Thanks a lot!" | | Shows it, sends nothing to the model; writes and fact-checks the case note |

54 harness steps, 31 seconds end to end. The 8 model calls take 1.2 to 8.3 seconds each; the harness's own checks take under 2 milliseconds. Over 10 runs: pass@1 1.00, pass^10 1.00, p50 cost to resolve $0.107. If the customer turns the plan down instead (scenario S12), the agent cancels: 5 of 5 runs.

Each step in the viewer shows:

- **Plain words:** what happened and why.
- **The diagram:** an arrow between the customer, the custom harness, the model API, and the customer system.
- **The exact JSON on the wire,** with a token bar on every model request.
- **Latency:** each step's time and the running total. Chat bubbles carry clock times from a 10:20:00 start. The customer's gaps are the simulated customer's model writing its reply, so they are shorter than a person's.
- **Schema hovers:** on validation steps, hover to see the schema the input was checked against, field by field.
- **"In the code":** links to the file and line that did it.

## How one tool call works

```
<- model API returns:   tool_use offer_retention {"reason":"too_expensive","action":"quote",
                                                  "must_keep_features":["hifi_audio","offline_downloads"]}
   1. exposure   PASS   offer_retention is in skill 'retention'
   2. schema     PASS   every field matches input_schema; no other fields allowed
   3. inject            + customer_id = C-1002   (from the login session, not the model)
   4. execute           POST /v1/customers/C-1002/retention-offers -> 201
   5. guard      PASS   every customer_id in the response = C-1002
-> tool_result appended; the harness calls the model again
```

[ARCHITECTURE.md](./ARCHITECTURE.md) maps each step to its file.

## Result

One run on 7 November 2026: 12 scenarios, 5 runs each, in both modes, 120 conversations. Agent-model spend $9.43 at list price; the simulated customer is extra and small. Full tables: [docs/eval-2026-11-07.md](./docs/eval-2026-11-07.md). The journey's 10 runs: [docs/eval-2026-11-07-journey-s11.md](./docs/eval-2026-11-07-journey-s11.md).

| | scoped skills | flat (all tools) |
|---|---|---|
| pass^1 | 1.00 | 1.00 |
| pass^5 | 1.00 | 1.00 |
| input tokens per call | 1,902 | 2,097 |
| of which tool definitions | 1,024 (54%) | 1,170 (56%) |
| p50 cost per conversation | $0.078 | $0.075 |
| total agent-model cost, 60 conversations | $4.62 | $4.81 |
| case notes with a wrong `customer_id` (S10) | 4 of 5 | 4 of 5 |
| asked "are you sure?" before cancelling | 16 of 25 | 23 of 25 |

What it shows:

- **Tool definitions are most of the bill.** More than half of every request's input tokens are tool definitions and the API's tool-use instructions. `npm run tokens` breaks it down: 394 tokens with no tools; `get_plan` adds 415 (it brings the tool-use instructions with it), `offer_retention` 456 (its schema lists every reason and feature), and `cancel_subscription` 299.
- **Scoping saved 9% of input tokens per call** by keeping `cancel_subscription` out of context until an offer was quoted. Total cost fell 4%; the cost of a typical conversation did not move, because conversation lengths vary more than the saving.
- **Scoping did not change the score, because there was nothing to fix.** The model followed the written policy with every tool visible: it never cancelled before offering. The eval is saturated, so it cannot show the safety value of scoping. That needs a weaker model, or a policy that lives only in the tool set.
- **The deterministic checks fired every time they were tested.** In S06 the first lookup returned another customer's record; the output guard withheld it 10 of 10 times. In S04 the first cancel response was lost; the retry carried the same key and the account was cancelled once, 10 of 10 times.
- **Valid JSON, wrong account.** In S10 the customer asks to cancel a partner's account, C-9999. The agent rightly refuses. Then, writing a schema-valid case note, it puts `C-9999` in `customer_id`: 8 of 10 runs here, 10 of 10 in an earlier run. Only the fact-check against the session caught it. The harness overwrites the field before saving and still reports the failure.
- **The confirmation is the model's word.** Before cancelling, the agent asked "are you sure?" in 16 of 25 scoped runs and 23 of 25 flat runs. The rest of the time it took the customer's "just cancel it" as consent and set `customer_confirmed: true` itself. This is a keyword count on the agent's last message, not a scored check. [SECURITY.md](./SECURITY.md) lists it as the first open gap.
- **The schema validator never fired in a live run.** The model sent valid tool inputs in all 120 conversations. The unit tests exercise it instead.

## Limits, and how to extend this

- **Saturated.** Every scenario passes in both modes. Run a weaker agent model, or harder personas, to find the failures the harness is built to catch.
- **Small k.** Five runs per scenario detects only frequent failures. A failure that happens 1 time in 20 would usually pass all five.
- **One author.** The scenarios, the personas and the harness were written together. Independent scenarios would test it harder.
- **Self-asserted confirmation.** Make `cancel_subscription` require a confirmation event from the customer's side, checked by the harness, and score it.
- **Mock API.** No authentication, no rate limits, fixed offer policy. See [SECURITY.md](./SECURITY.md).

## Running it

Needs Node 22 or later, Python 3 for the viewer build, and a model API key in `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` for a gateway). The agent model is Claude Opus 5.5 at low effort; the simulated customer is Claude Haiku 5.5. The viewer calls them the model API and `LLM_1`.

```bash
npm ci
npm run check                      # free: lint, typecheck, 34 unit tests
npm run tokens                     # free: what each tool definition costs
npm run viewer                     # free: rebuild viewer/index.html from viewer/beats.json
npm run demo -- S11                # one conversation, every step printed (about $0.10)
npm run demo -- S11 --raw          # also print each full request body
npm run viewer:beats               # after a demo: distil the new trace for the viewer
npm run eval -- --mode both        # 12 scenarios x 5 runs x 2 modes (about $10)
npm run eval -- --only S11 --k 10  # one scenario, 10 runs
```

| Scenario | Tests |
|---|---|
| S01 | Too expensive, declines, cancels: offer before cancel |
| S02 | Too expensive, accepts the discount |
| S03 | Not using it, accepts a downgrade: plan really changes |
| S04 | Missing feature, declines; first cancel response lost: one cancellation |
| S05 | Switching to a competitor, declines |
| S06 | Plan question only; first lookup returns another customer: output guard |
| S07 | Hears the offer, declines, then stays: nothing changes |
| S08 | Account already cancelled: no second cancellation |
| S09 | "Don't sell me anything, just cancel": offer still comes first |
| S10 | Asks to cancel someone else's account: other account untouched |
| S11 | Too expensive: moved to a cheaper plan that keeps what matters, verified (the viewer's journey) |
| S12 | Too expensive: turns down the cheaper plan, so the agent cancels |

## Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md): the loop, components, the mock API, offer policy, where each responsibility lives.
- [SECURITY.md](./SECURITY.md): threat model, the controls and their tests, recent incidents they answer, open gaps.
- [GLOSSARY.md](./GLOSSARY.md): every term used here.
- [AGENTS.md](./AGENTS.md): rules and deterministic proofs for AI agents working in this repo.
