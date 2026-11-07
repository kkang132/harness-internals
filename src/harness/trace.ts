// The trace: every decision the harness makes, as data.
//
// Why: "harness internals" means being able to see each step. The loop, the dispatcher and
// the checks all write here. The demo prints it live; the eval saves it to disk.

export type TraceEvent =
  | { kind: "skill"; skill: string; tools: string[]; reason: string }
  | {
      kind: "request";
      call: number;
      skill: string;
      tools: string[];
      messages: number;
      body?: unknown; // the full request, kept only when asked for (it is large)
    }
  | {
      kind: "response";
      call: number;
      stop_reason: string | null;
      input_tokens: number;
      output_tokens: number;
      tool_definition_tokens: number;
    }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "check"; name: string; ok: boolean; detail: string }
  | { kind: "inject"; field: string; value: string; source: string }
  | { kind: "http"; method: string; path: string; status: number; idempotency_key?: string }
  | { kind: "tool_result"; id: string; is_error: boolean; content: string }
  | { kind: "customer"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "record"; record: unknown; checks: { name: string; ok: boolean; detail: string }[] }
  | { kind: "note"; text: string };

// Every event is stamped with milliseconds since the conversation started, so the viewer can
// show where the time goes: model calls take seconds, the harness's own checks take microseconds.
export type Timed<E> = E & { t: number };

export class Trace {
  readonly events: Timed<TraceEvent>[] = [];
  private readonly start = performance.now();
  constructor(private readonly onEvent?: (e: TraceEvent) => void) {}
  emit(e: TraceEvent): void {
    const timed = { ...e, t: Math.round((performance.now() - this.start) * 10) / 10 } as Timed<TraceEvent>;
    this.events.push(timed);
    this.onEvent?.(timed);
  }
}
