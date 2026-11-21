# Turns a recorded demo trace into "beats" for the step-through viewer.
#
# Why a separate step: traces live under results/, which git ignores (they are large and
# local). This script distils one trace, plus the latest eval rows for its scenario, into
# viewer/beats.json, which is committed. build_html.py then needs nothing but that file.
import json, glob, sys

CH = [
  ("S11", "Handle Cancel Request and Offer Different Subscription", "", None, "S11-scoped-*.json"),
]

# Source anchors: (file, search string). Line numbers are looked up, so they stay right as code moves.
import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
def at(path, needle, what):
  for n, line in enumerate(open(os.path.join(ROOT, path)), 1):
    if needle in line: return {"file": path, "line": n, "what": what}
  raise SystemExit(f"anchor not found: {path}: {needle}")
SRC = {
  "customer": [at("src/harness/loop.ts", 'messages.push({ role: "user", content: customerText })', "append the customer's message")],
  "skill": [at("src/harness/skills.ts", "export function selectSkill", "pick the skill from session state"),
            at("src/harness/skills.ts", "const RETENTION: Skill", "the skill definitions")],
  "request": [at("src/harness/loop.ts", "function buildRequest", "build the request body"),
              at("src/llm/model-api.ts", "export async function createMessage", "send it over HTTP")],
  "tool_use": [at("src/harness/loop.ts", 'res.stop_reason === "tool_use"', "spot the tool request")],
  "text": [at("src/harness/loop.ts", "const reply = textOf(res.content)", "take the text reply")],
  "checks": [at("src/harness/dispatch.ts", "// 1. Exposure.", "exposure check"),
             at("src/harness/dispatch.ts", "// 2. Schema.", "schema check"),
             at("src/harness/validate.ts", "export function validate", "the validator")],
  "inject": [at("src/harness/tools.ts", 'field: "customer_id"', "add customer_id from the session"),
             at("src/harness/session.ts", "export function cancelIdempotencyKey", "derive the idempotency key")],
  "http": [at("src/harness/tools.ts", "const res = await fetch(", "the HTTP call")],
  "retry": [at("src/harness/tools.ts", "if (r.status >= 500) {", "retry once with the same key")],
  "sys_ok": [at("src/customer-system/server.ts", "handle(method: string", "the mock API's routes")],
  "sys_lost": [at("src/customer-system/server.ts", "if (this.faults.loseFirstCancelResponse) {", "the injected fault")],
  "sys_replay": [at("src/customer-system/server.ts", "const seen = this.idempotency.get", "replay a key it has seen")],
  "guard": [at("src/harness/dispatch.ts", "// 5. Output guard", "output customer_id check"),
            at("src/harness/dispatch.ts", "export function foreignCustomerIds", "walk the JSON")],
  "tool_result": [at("src/harness/loop.ts", "messages.push({ role: \"user\", content: results })", "append all results, call again")],
  "show": [at("src/harness/loop.ts", 'chat.push({ who: "agent"', "show the reply")],
  "record": [at("src/harness/record.ts", "export async function writeCaseRecord", "ask for the record")],
  "record_json": [at("src/harness/record.ts", "parseJsonObject(textOf(res.content))", "parse it")],
  "record_check": [at("src/harness/record.ts", "export function checkCaseRecord", "check it"),
                   at("src/harness/record.ts", "export function enforceCaseRecord", "overwrite customer_id")],
}

def abbreviate_request(body):
  msgs = body["messages"]
  shown = msgs[-1:]
  return {
    "model": "LLM_1",
    "max_tokens": body["max_tokens"],
    "system": f"<{len(body['system'])} characters: the {'' } skill prompt>",
    "tools": body["tools"],
    "messages": ([f"<{len(msgs)-1} earlier messages, resent in full>"] if len(msgs) > 1 else []) + shown,
    "thinking": body.get("thinking"),
    "output_config": body.get("output_config"),
  }

def field_rows(schema, inp):
  rows = []
  props = schema.get("properties", {})
  for name, ps in props.items():
    v = inp.get(name, None)
    if "enum" in ps: rule = "one of " + ", ".join(map(str, ps["enum"])); ok = v in ps["enum"]
    elif "const" in ps: rule = f"must equal {json.dumps(ps['const'])}"; ok = v == ps["const"]
    else: rule = ps.get("type", "any"); ok = v is not None
    if name in schema.get("required", []): rule = "required, " + rule
    rows.append({"field": name, "value": v, "rule": rule, "ok": ok and (name in inp or name not in schema.get("required", []))})
  extra = [k for k in inp if k not in props]
  if schema.get("additionalProperties") is False:
    rows.append({"field": "(any other field)", "value": extra or None, "rule": "not allowed: additionalProperties is false, so customer_id cannot be passed", "ok": not extra})
  return rows

def build(pattern, sid):
  f = sorted(glob.glob(os.path.join(ROOT, "results", "traces", pattern)))[-1]
  d = json.load(open(f))
  ev = d["events"]
  beats, chat = [], []
  pending_req = None
  tools_by_name = {}
  accepted = False
  i = 0
  # pre-scan: for each request index find its response
  while i < len(ev):
    e = ev[i]; k = e["kind"]
    b = None
    if k == "customer":
      chat.append({"who": "customer", "text": e["text"], "t": e["t"]})
      closing = not any(x["kind"] == "request" for x in ev[i+1:])
      opening = not chat
      b = dict(lane=("C","H"), label="message", title="The customer signs off" if closing else "The customer writes", src=SRC["customer"],
        text=("The chat opens. The harness appends the message to the history as a user message. Nothing has gone to the model yet." if opening else
              "The customer says thanks and leaves the chat. The harness shows the message but sends nothing to the model: nobody is waiting for a reply." if closing else
              "The harness appends it to the history as a user message. Nothing has gone to the model yet. The time on this step is the simulated customer writing its reply; a person would take longer."),
        raw={"role": "user", "content": e["text"]})
    elif k == "skill":
      first = e["reason"] == "conversation start"
      b = dict(lane=("H","H"), label=f"load skill: {e['skill']}", title=f"Skill loaded: {e['skill']}", src=SRC["skill"],
        tone="skill",
        text=("The harness picks which tools the model may see. The retention skill has three: look up the account, make an offer, and hand off to a person. There is no cancel tool in it, so the model cannot cancel before making an offer, whatever the customer says."
              if first else
              "An offer has now been quoted, so the harness swaps in the cancellation skill and adds cancel_subscription to the tool list. It is the fallback: if the customer turns down the new plan, the model can now cancel for them. It was held back until now so the model could not cancel before making an offer. The model learns the tool exists only because its definition is in the next request."),
        raw={"skill": e["skill"], "tools": e["tools"], "why": e["reason"]})
    elif k == "request":
      if e.get("body"): tools_by_name.update({t["name"]: t for t in e["body"]["tools"]})
      resp = next(x for x in ev[i:] if x["kind"] == "response")
      body = e.get("body")
      b = dict(lane=("H","M"), label=f"model request #{e['call']}", title=f"Request #{e['call']} to the model API", src=SRC["request"],
        text=f"The API remembers nothing between calls, so every request resends the system prompt, all {len(e['tools'])} tool definitions and all {e['messages']} messages so far. The tool definitions alone are about {resp['tool_definition_tokens']} of the {resp['input_tokens']} input tokens.",
        raw=abbreviate_request(body) if body else {"note": "body not recorded"},
        tokens={"input": resp["input_tokens"], "tools": resp["tool_definition_tokens"]})
    elif k == "response":
      j = i + 1
      thinking = None
      tus = []
      while j < len(ev) and ev[j]["kind"] in ("thinking", "tool_call", "agent") :
        if ev[j]["kind"] == "thinking": thinking = ev[j]["text"]
        if ev[j]["kind"] == "tool_call": tus.append(ev[j])
        if ev[j]["kind"] == "agent": break
        j += 1
      if e["stop_reason"] == "tool_use":
        # every tool call in this response: those before the next request or reply
        tus = []
        for x in ev[i+1:]:
          if x["kind"] in ("request", "agent", "record"): break
          if x["kind"] == "tool_call": tus.append(x)
        content = ([{"type": "thinking", "thinking": thinking}] if thinking else []) + \
          [{"type": "tool_use", "id": t["id"], "name": t["name"], "input": t["input"]} for t in tus]
        names = " + ".join(t["name"] for t in tus)
        verify = accepted and any(t["name"] == "get_plan" for t in tus)
        if any(t["name"] == "offer_retention" and (t["input"] or {}).get("action") == "accept" for t in tus): accepted = True
        many = len(tus) > 1
        b = dict(lane=("M","H"), label=f"tool_use: {names}" + ("  (verify)" if verify else ""), title=("The model verifies the change" if verify else ("The model asks for tools" if many else "The model asks for a tool")), src=SRC["tool_use"],
          tone="model",
          text=(f"This is the tool call. The model did not run anything. It wrote {len(tus)} tool_use blocks in one reply ({', '.join(t['name'] for t in tus)}) and stopped with stop_reason \"tool_use\". The harness runs them one at a time, in order, and sends all the results back together." if many else
                f"This is the tool call. The model did not run anything. It wrote a JSON block naming {tus[0]['name']} and its input, and stopped with stop_reason \"tool_use\". What happens next is up to the harness."),
          raw={"stop_reason": e["stop_reason"], "usage": {"input_tokens": e["input_tokens"], "output_tokens": e["output_tokens"]}, "content": content})
        if verify:
          b["text"] = "The plan change has been written. Before telling the customer it's done, the model reads the account back with get_plan. The tool description told it to: the confirmation it gives will rest on what the customer system now says, not on what it expects."
      else:
        ag = next(x for x in ev[i+1:] if x["kind"] == "agent")
        b = dict(lane=("M","H"), label="text reply", title="The model replies in words", src=SRC["text"],
          text="No tool this time: stop_reason is \"end_turn\". The harness shows the text to the customer and waits.",
          raw={"stop_reason": e["stop_reason"], "usage": {"input_tokens": e["input_tokens"], "output_tokens": e["output_tokens"]},
               "content": ([{"type": "thinking", "thinking": thinking}] if thinking else []) + [{"type": "text", "text": ag["text"]}]})
    elif k == "tool_call":
      if ev[i-1]["kind"] == "tool_result":
        beats.append(dict(t=e["t"], lane=("H","H"), label=f"next tool_use: {e['name']}", title=f"Next tool call from the same reply: {e['name']}",
          tone="inject", src=SRC["tool_use"], chat=None,
          text=f"The first result is held, not sent yet. The harness moves to the model's next tool_use block, {e['name']}, and runs the same checks on it.",
          raw={"type": "tool_use", "id": e["id"], "name": e["name"], "input": e["input"]}))
      # gather this tool call's events until tool_result
      j = i + 1; group = []
      while ev[j]["kind"] != "tool_result": group.append(ev[j]); j += 1
      res = ev[j]
      checks = [g for g in group if g["kind"] == "check"]
      pre = [c for c in checks if c["name"] in ("exposure", "schema")]
      b = dict(t=(pre[-1]["t"] if pre else e["t"]), lane=("H","H"), label="check exposure + schema", title="Check 1 and 2: is this call allowed, and well formed?", src=SRC["checks"],
        tone="pass" if all(c["ok"] for c in pre) else "fail",
        text=f"Exposure: is {e['name']} in the current skill? Schema: does the input match the tool's input_schema? A failure here would go back to the model as an error result, not crash the loop.",
        raw={"tool": e["name"], "input": e["input"], "checks": [{c["name"]: "PASS" if c["ok"] else "FAIL", "detail": c["detail"]} for c in pre]},
        schema=tools_by_name.get(e["name"], {}).get("input_schema"),
        fields=field_rows(tools_by_name.get(e["name"], {}).get("input_schema") or {}, e["input"]))
      beats.append(b); b = None
      injects = [g for g in group if g["kind"] == "inject"]
      https = [g for g in group if g["kind"] == "http"]
      notes = [g for g in group if g["kind"] == "note"]
      inj = {x["field"]: x["value"] for x in injects}
      beats.append(dict(t=(injects[-1]["t"] if injects else e["t"]), lane=("H","H"), label="inject " + ", ".join(inj), title="Step 3: the harness adds what the model must not supply", src=SRC["inject"],
        tone="inject",
        text="The model's input had no customer_id, because the schema has none. The harness takes it from the login session." + (" For a cancel it also adds an Idempotency-Key, derived from the session, so the same cancel can never run twice." if "Idempotency-Key" in inj else "") + (" For accept it adds the offer_id it saved when the offer was quoted." if "offer_id" in inj else ""),
        raw={"from_model": e["input"], "added_by_harness": {k2: f"{v}  (from {next(x['source'] for x in injects if x['field']==k2)})" for k2, v in inj.items()}}))
      for n, h in enumerate(https):
        replay = n > 0 and h["status"] == 200 and h.get("idempotency_key")
        beats.append(dict(t=((notes[0]["t"] if notes else https[n-1]["t"]) if n > 0 else (injects[-1]["t"] if injects else h["t"])), lane=("H","S"), label=f"{h['method']} {h['path'].replace('/v1/customers','…')}", title="Step 4: a real HTTP call" if n == 0 else "Retry with the same key", src=SRC["http"] if n == 0 else SRC["retry"],
          text=("The harness calls the customer system over HTTP. The URL carries the session's customer_id." if n == 0 else
                "Same request, same Idempotency-Key. The customer system has seen this key, so it does not cancel again: it replays the result it stored the first time."),
          raw={"request": {"method": h["method"], "path": h["path"], **({"headers": {**({"traceparent": h["traceparent"]} if h.get("traceparent") else {}), **({"Idempotency-Key": h["idempotency_key"]} if h.get("idempotency_key") else {})}} if h.get("traceparent") or h.get("idempotency_key") else {})}}))
        beats.append(dict(t=h["t"], lane=("S","H"), label=f"HTTP {h['status']}" + ("  (replayed)" if replay else ""), title=("The reply is lost" if h["status"] >= 500 else ("The stored result comes back" if replay else "The customer system answers")),
          tone="fail" if h["status"] >= 500 else None,
        src=SRC["sys_lost"] if h["status"] >= 500 else (SRC["sys_replay"] if replay else SRC["sys_ok"]),
          text=("The account was in fact cancelled, but the reply never arrived: a 503. A naive retry would risk a second cancellation. The harness retries once, with the same key." if h["status"] >= 500 else
                ("One cancellation in the system's log, plus one idempotent replay. The customer is cancelled exactly once." if replay else "Status and JSON body, as any API would return.")),
          raw={"status": h["status"]} if h["status"] >= 500 else {"status": h["status"], "body": json.loads(res["content"]) if not res["is_error"] and n == len(https)-1 else "(withheld by the output check, next step)"}))
      guard = next(c for c in checks if c["name"] == "output customer_id")
      beats.append(dict(t=guard["t"], lane=("H","H"), label="check output customer_id", title="Check 5: does every customer_id in the reply belong to this session?", src=SRC["guard"],
        tone="pass" if guard["ok"] else "fail",
        text=("Yes. The harness walks the whole JSON and compares every customer_id field with the session." if guard["ok"] else
              "No. The customer system returned another customer's record (we injected this fault). The harness withholds the data entirely. The model never sees Alex Kim's account; it gets an error and retries."),
        raw={"session_customer_id": next(iter([x["value"] for x in injects if x["field"]=="customer_id"]), None), "result": "PASS" if guard["ok"] else "FAIL", "detail": guard["detail"]}))
      tr = {"type": "tool_result", "tool_use_id": res["id"], "content": res["content"]}
      if res["is_error"]: tr["is_error"] = True
      beats.append(dict(t=res["t"], lane=("H","M"), label="tool_result" + (" (is_error)" if res["is_error"] else ""), title="The result goes back to the model" if not res["is_error"] else "An error goes back as a result", src=SRC["tool_result"],
        tone="fail" if res["is_error"] else None,
        text=(("The result is ready as a tool_result block, but the reply had another tool call, so it waits. All results go back to the model together in one message." if j + 1 < len(ev) and ev[j+1]["kind"] == "tool_call" else
               "The harness appends the tool_result blocks to the history as one user message, then calls the model again. The model reads the results as text in its context.") if not res["is_error"] else
              "Errors are results too. The model reads why it failed and decides what to do; here it simply calls get_plan again."),
        raw=tr))
      i = j + 1
      continue
    elif k == "agent":
      chat.append({"who": "agent", "text": e["text"], "t": e["t"]})
      b = dict(lane=("H","C"), label="show reply", title="The customer sees the reply", src=SRC["show"],
        text="Everything above happened between two chat bubbles. The customer sees none of it.", raw={"shown_to_customer": e["text"]})
    elif k == "record":
      rec = e["record"]
      beats.append(dict(t=beats[-1]["t"], lane=("H","M"), label="write case note", title="After the chat: the model writes a case note for the CRM", src=SRC["record"],
        text="The customer already has their confirmation, and it rested on the plan change the customer system made and the model then read back. The case note is after-call work: a summary for the support team's CRM, written from the whole transcript once the chat is over. Structured outputs make the reply match a JSON schema.",
        raw={"output_config": {"format": {"type": "json_schema", "schema": {"customer_id": "string", "outcome": "cancelled | retained_with_offer | no_change", "offer_presented": "boolean", "summary": "string"}}}}))
      beats.append(dict(t=e["t"], lane=("M","H"), label="case note JSON", title="The model writes the case note", src=SRC["record_json"],
        tone="model",
        text="Valid JSON, every field present. But the model wrote these values from its reading of the transcript, so any of them could still be wrong. A schema checks the shape of an answer, not whether it is true.",
        raw=rec))
      ok = all(c["ok"] for c in e["checks"])
      truth = {c["name"]: c["detail"].split(", ")[1].split(" ", 1)[1] for c in e["checks"]}
      def row(field, check, source):
        c = next(x for x in e["checks"] if x["name"] == check)
        return [field, json.dumps(rec[field]), c["detail"].split(", ")[1].split(" ", 1)[1], source, "PASS" if c["ok"] else "FAIL"]
      beats.append(dict(t=e["t"], lane=("H","H"), label="fact-check case note", title="Fact-check the case note before saving it", src=SRC["record_check"],
        tone="pass" if ok else "fail",
        text=("The harness checks the three fields it can prove against facts it already holds: customer_id against the login session, and outcome and offer_presented against the customer system's own log of what happened. Free text such as summary cannot be checked this way. All three match, so the note is saved." if ok else
              "The harness checks the three fields it can prove against facts it already holds. One does not match, so the harness corrects it from the source of truth before saving, and reports the failure."),
        table={"columns": ["Field", "Model wrote", "Truth", "Source of truth", "Result"],
               "rows": [row("customer_id", "record.customer_id = session", "login session"),
                        row("outcome", "record.outcome = system of record", "customer system event log"),
                        row("offer_presented", "record.offer_presented = system of record", "customer system event log")]},
        raw={"checks": [{c["name"]: "PASS" if c["ok"] else "FAIL", "detail": c["detail"]} for c in e["checks"]]}))
      i += 1; continue
    if b:
      b["chat"] = len(chat)
      b.setdefault("t", e["t"])
      beats.append(b)
    i += 1
  for b in beats: b.setdefault("chat", None)
  # fill chat counts forward
  last = 0
  for b in beats:
    if b["chat"] is None: b["chat"] = last
    last = b["chat"]
  # Latency: each step's time since the step before, and the running total.
  t0 = beats[0]["t"]
  prev = t0
  for b in beats:
    b["lat_ms"] = round(b["t"] - prev, 1)
    b["cum_ms"] = round(b["t"] - t0, 1)
    prev = b["t"]
  span_count = attach_spans(d, beats)
  return {"chat": chat, "beats": beats, **({"span_count": span_count} if span_count else {})}

# OpenTelemetry: traces recorded since spans were added carry span_id on every event and a
# "spans" list. Each beat gets the span of the last event at or before its time, so the
# viewer's OTel drawer can show span name, ids, traceparent and gen_ai.* attributes.
# Older traces have neither, and the drawer stays hidden.
def attach_spans(d, beats):
  spans = {s["span_id"]: s for s in d.get("spans", [])}
  timed = [(e["t"], e["span_id"]) for e in d["events"] if "span_id" in e]
  if not spans or not timed: return 0
  for b in beats:
    sid = None
    for t, s in timed:
      if t > b["t"]: break
      sid = s
    span = spans.get(sid)
    if span:
      b["span"] = {**span, "kind": "CLIENT" if span["name"] in ("gen_ai.chat", "gen_ai.case_record") else "INTERNAL"}
  return len(spans)

from math import comb
from statistics import median
def stats(sid):
  runs = []
  for f in sorted(glob.glob(os.path.join(ROOT, "results", "eval-*", "rows.json"))):
    rows = [r for r in json.load(open(f)) if r["scenario"] == sid and r["mode"] == "scoped" and "cost_usd" in r]
    if rows and len(rows) >= len(runs): runs = rows  # the eval with the most runs; latest on a tie
  if not runs: return None
  n, c = len(runs), sum(r["pass"] for r in runs)
  resolved = [r["cost_usd"] for r in runs if r["pass"]]
  return {"n": n, "passes": c, "pass_at_1": c / n, "pass_hat_n": comb(c, n) / comb(n, n),
          "p50_cost_usd": median(resolved) if resolved else None}

out = []
for sid, name, sub, fault, pat in CH:
  c = build(pat, sid); c.update(id=sid, name=name, sub=sub, fault=fault, stats=stats(sid)); out.append(c)
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "viewer", "beats.json"), "w"))
for c in out: print(c["id"], len(c["beats"]), "beats", len(c["chat"]), "chat lines")
