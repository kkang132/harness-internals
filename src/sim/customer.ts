// The simulated customer: a small, cheap model playing a scripted persona.
//
// Why a model and not fixed lines: the agent's wording varies run to run, so a fixed script
// drifts out of step (answering a question that was not asked). A persona with a goal and
// a few hard rules stays in step and still behaves the same way every run.
//
// It sees only what a real customer sees: the visible chat. No tool calls, no results.

import { createMessage, textOf } from "../llm/model-api.ts";

export const DONE = "###DONE###";

export type ChatLine = { who: "customer" | "agent"; text: string };

export async function nextCustomerMessage(model: string, persona: string, chat: ChatLine[]): Promise<string> {
  const rendered = chat.map((l) => `${l.who === "customer" ? "You" : "Support"}: ${l.text}`).join("\n");
  const res = await createMessage({
    model,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system: `You are role-playing a customer in a support chat with Brightline, a music streaming service. Stay in character.

Your persona and goal:
${persona}

Rules:
- Write only your next chat message: one or two short sentences, casual.
- Follow your persona's decisions exactly. Do not change your mind unless the persona says to.
- If support asks you to confirm something your persona wants, confirm it plainly.
- When your goal is met, or support has clearly told you it cannot be done, end the chat: write your closing words, if any, followed by ${DONE}`,
    messages: [{ role: "user", content: `The chat so far:\n${rendered}\n\nYour next message:` }],
  });
  return textOf(res.content);
}
