# Glossary

**Harness.** The program around a model. It sends requests, runs the tools the model asks for, checks their inputs and outputs, and decides what goes back. The model only ever produces text and tool requests; everything that touches the world is the harness.

**Tool.** A function the harness offers the model. The model sees a name, a description and a JSON Schema for the input. It asks for a call by returning a `tool_use` block; the harness runs it and returns a `tool_result` block.

**Learned tool calling.** The model was never trained on these particular tools. It works out when and how to call them from the definitions in its context, using a general skill learned in training.

**Tool definitions as input tokens.** The API is stateless, so every request carries the full list of tool definitions. They are billed as input tokens on every call. Adding the first tool also adds the API's own tool-use instructions.

**Skill.** Here, a prompt fragment plus a set of tools, loaded together. Fewer tools means fewer tokens per call and fewer ways to go wrong.

**JSON Schema.** A standard way to describe the shape of a JSON value: which fields, which types, which values are allowed. `additionalProperties: false` forbids fields not listed.

**Injection (of a field).** The harness adds a value to an outgoing request that the model never supplied, such as `customer_id` from the login session.

**Idempotency key.** A unique key sent with a request that must not happen twice. If the same key arrives again, the server returns the stored result instead of repeating the action. It makes retries safe.

**Output guard.** A deterministic check on data coming back from a tool, before the model sees it. Here: every `customer_id` in the response must be the session's.

**Structured output.** An API mode that forces the model's reply to match a JSON Schema. It guarantees shape, not truth.

**System of record.** The source that is authoritative about what happened: here, the customer system's event log, not the transcript.

**Simulated customer.** A second, cheaper model playing a customer from a short persona. It sees only the visible chat.

**pass@1.** The share of single runs that pass. With one run per try, it is the same number as pass^1.

**pass^k.** The probability that k independent runs of the same scenario all pass. pass^1 is the success rate; pass^5 measures whether you can rely on it. Estimated as C(c, k) / C(n, k) from c passes in n runs, averaged over scenarios.

**Ablation.** Removing one feature to see what it was doing. Here, `flat` mode removes skill scoping.

**p50 cost to resolve.** The median cost of a conversation that ended in the right state: half cost less, half more. It counts the agent model's calls and the case note, not the simulated customer.

**Case note.** The JSON summary the model writes for the support team's CRM after the chat. Written under structured outputs, then fact-checked.

**Fact-check.** Comparing fields of model-written JSON with facts the harness already holds: the session, and the customer system's log.

**Verify after write.** Reading the account back after changing it, so the confirmation the customer hears rests on what the system says, not on what the model expects.

**Prompt injection.** Text that tries to give the model instructions it should not follow. Direct when the user types it; indirect when it arrives inside data the model reads, such as a support ticket or a web page.

**Excessive agency.** Giving a model more tools, permissions or autonomy than its job needs. OWASP lists it as LLM06.

**CVE.** Common Vulnerabilities and Exposures: a public ID for one disclosed security flaw, such as CVE-2026-102610.

**CVSS.** Common Vulnerability Scoring System: a 0 to 10 severity score attached to a CVE.

**Escalation (hand-off).** Passing the conversation to a person. Here, the `escalate_to_human` tool opens a ticket with a summary for the retention team, and the harness ends the agent's part of the chat.

**Adapter.** A small piece of code that translates between two formats at the edge, so the code on either side does not change. Here, `src/llm/openai-compatible.ts` translates the harness's messages to and from the chat completions format.

**OpenAI-compatible API.** A server that accepts the `/v1/chat/completions` request format OpenAI introduced. Ollama, vLLM and LM Studio all offer one, which is how a local model can stand in for a hosted one.

**Local model.** A model running on your own machine, for example through Ollama. No per-token cost, and the conversation never leaves the machine.

