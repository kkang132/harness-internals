# Security

This is a teaching toy, not a product. It has no users, no real accounts, and no secrets beyond the API key in your own environment. This document says what the harness defends against, which recent public incidents those defences answer, and what it leaves open. Every claim in "What the harness enforces" is backed by a deterministic test named beside it.

## Threat model

| Input | Trusted? | Why |
|---|---|---|
| The login session (`customer_id`) | Yes | It comes from authentication, before the model sees anything. |
| The customer system's state and event log | Yes | It is the system of record. The eval scores from it. |
| The customer's messages | No | Anyone can type anything, including instructions aimed at the model. |
| Tool results | Partly | They come from our own API, but in production they carry text other people wrote (names, tickets, notes). |
| Anything the model produces | No | Tool inputs, replies and the case note are all generated text. A model can be persuaded, and can be wrong. |

The design rule follows from the table: **the model proposes, the harness decides.** Anything that must be true is checked by code against a trusted source, not asked of the model.

## What the harness enforces

| Control | Where | Proven by |
|---|---|---|
| **Identity comes from the session, never the model.** No tool schema has a `customer_id`; `additionalProperties: false` rejects one if the model adds it; the harness writes the session's ID into every request URL. | `src/harness/tools.ts` (`call`), `src/harness/validate.ts` | `validate.test.ts`: never mention customer_id; reject a customer_id the model adds. `dispatch.test.ts`: adds the session's customer_id to every call. |
| **Least privilege, by skill.** Three narrow tools, no shell, no files, no URL fetching. The cancel tool is not in context until an offer has been quoted. The dispatcher refuses a tool outside the current skill even if the model names it. | `src/harness/skills.ts`, `src/harness/dispatch.ts` step 1 | `skills.test.ts`: hides cancel_subscription until an offer is quoted. `dispatch.test.ts`: refuses a tool outside the current skill. |
| **Every tool input is validated** against its JSON Schema before anything runs, including each item of a list. Failures return to the model as errors. | `src/harness/validate.ts`, `dispatch.ts` step 2 | `validate.test.ts`, `dispatch.test.ts`: schema error returned as is_error. |
| **The model cannot invent offers or IDs.** The customer system chooses the offer from the reason; the harness remembers the quoted `offer_id` and supplies it on accept; the API refuses another customer's offer. | `src/customer-system/data.ts`, `tools.ts` (`offer_retention`) | `dispatch.test.ts`: uses the session's quoted offer on accept. `customer-system.test.ts`: refuses to accept another customer's offer. |
| **Output guard against cross-account data.** Every `customer_id` anywhere in a tool response must be the session's, or the whole response is withheld from the model. | `dispatch.ts` step 5 | `dispatch.test.ts`: withholds a response that belongs to another customer. |
| **Irreversible actions are idempotent.** The cancel carries a key derived from the session; a retry after a lost response replays the stored result. | `src/harness/session.ts`, `server.ts` | `customer-system.test.ts`, `dispatch.test.ts`: same Idempotency-Key on retry, one cancellation. |
| **Model-written JSON is fact-checked.** Structured outputs fix the case note's shape; the harness checks `customer_id`, `outcome` and `offer_presented` against the session and the event log, and overwrites `customer_id` before saving. | `src/harness/record.ts` | `record.test.ts`. In the eval, scenario S10 caught a wrong `customer_id` in 10 of 10 runs. |
| **Bounded loops.** At most 6 model calls per customer turn and 8 customer turns per conversation. API retries stop at 5 and never retry a 400. | `src/harness/loop.ts`, `src/llm/model-api.ts` | Read the constants; no test. |
| **The mock API listens on loopback only**, on a random port, one server per conversation. | `server.ts` (`listen`) | `customer-system.test.ts`: binds to loopback only. |
| **Model text is never rendered as HTML.** The viewer escapes every string it shows, so a reply containing markup or an image tag displays as text and fetches nothing. | `viewer/template.html` (`esc`) | Read the template; no test. |

## Recent incidents these controls answer

Public disclosures from the last two months (7 September to 7 November 2026). None of these products is used here. The point is the class of failure, and which control above stops it in this harness.

| Date | Incident | What went wrong | Control here |
|---|---|---|---|
| 8 Sep 2026 | ChatGPT cross-account leak ([Check Point Research](https://research.checkpoint.com/2026/the-shared-clipboard-inside-the-sandbox-cross-account-data-leakage-in-chatgpt/)). No CVE. | A package service shared across accounts let a hidden instruction in one account move another user's Gmail data. | Output guard: another customer's data never reaches the model. Identity from the session. |
| 18 Sep 2026 | AWS AgentCore Harness credential theft ([Unit 42](https://unit42.paloaltonetworks.com/securing-aws-agentcore-harness-credentials/)). No CVE; AWS closed it as shared responsibility. | An instruction hidden in a **support ticket** drove a default-on, root-level shell tool to read a vault token from process memory. | Least privilege: no shell or file tools exist. The only actions are three narrow, schema-checked API calls. |
| 24 Sep 2026 | SalesBleed in Salesforce Agentforce ([Zenity Labs](https://labs.zenity.io/), coverage in [Dark Reading](https://www.darkreading.com/application-security/salesbleed-exploits-salesforce-agents-slack-phishing)). No CVE; fixed. | Instructions planted in a public web form made the agent query CRM records and leak them through an image URL resolved by DNS, and post to Slack without confirmation. | Tool scope: no query tool beyond the signed-in account. Output escaping in the viewer: no image fetch. The confirmation gap below is the same family as the Slack action. |
| Oct 2026 | CVE-2026-77521, MaxKB ([Adversa digest, 4 Oct](https://adversa.ai/blog/top-ai-agent-security-resources-october-2026/)) | Prompt injection in crawled content reached a shell tool that could not be removed; the sandbox checked only the first command, exposing other tenants' data. | No shell tool. Output guard against other accounts' data. |
| Oct 2026 | CVE-2026-65669, Copilot in SQL Server Management Studio ([Adversa digest, 4 Oct](https://adversa.ai/blog/top-ai-agent-security-resources-october-2026/)) | "Read-only" was enforced by bypassable regex blocklists; planted instructions ran SQL as the victim. | Allow-listing, not block-listing: the model can call only declared tools with schema-valid inputs, and identity is fixed by the session. |
| 19 Oct 2026 | CVE-2026-103091, Google OSS Agent Mesh ([OSV](https://osv.dev/vulnerability/CVE-2026-103091)), CVSS 9.3 | Any OIDC token holder could self-enrol and, under a wildcard default policy, call every MCP tool. | Per-skill tool exposure and the dispatcher's exposure check: being able to reach the harness does not mean every tool is callable. |
| 6 Nov 2026 | CVE-2026-102610, fast-agent ([Strix](https://www.strix.ai/cve/CVE-2026-102610)), CVSS 6.4, fixed in 0.7.21 | `serve` bound to 0.0.0.0 with no authentication, so any network client could invoke the agent's tools. | The mock API binds to 127.0.0.1 only. It still has no authentication: see gaps. |

These map onto the [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/): LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure, LLM05 Improper Output Handling, LLM06 Excessive Agency, and LLM10 Unbounded Consumption.

## What it does not defend against

Known gaps, deliberately left visible because they teach as much as the controls do.

1. **`customer_confirmed` is the model vouching for itself.** The harness takes the model's word that the customer agreed to cancel. In scenario S12 the model cancelled on "please just go ahead and cancel" without asking again. A prompt injection or a misread could cancel without consent. The fix is a confirmation event from the customer's channel (a button), checked by the harness.
2. **The mock API has no authentication or authorisation.** Anyone who can reach the loopback port can act on any account. The harness's session injection is the only guard. A real API must check a session token itself.
3. **The output guard checks only fields named `customer_id`.** Another customer's data under a different key would pass.
4. **Tool results are not filtered for instructions.** Text in a tool result reaches the model as is. Here the API returns only our own fixed strings; in production, names and notes are attacker-controlled.
5. **The case note's `summary` is free text and unchecked.**
6. **Idempotency does not compare request bodies.** A reused key with a different body would replay the first result instead of being refused.
7. **No request size limit** on the mock server, and **no rate limit** per customer.
8. **The cancel tool unlocks when an offer is quoted, not when it is declined.** The prompt, not the code, keeps the model from cancelling straight after quoting.

## Reporting

Open an issue. There is nothing private to disclose: the data is fictional and the API key is yours.
