// The trace: every decision the harness makes, as structured events and hierarchical spans.
//
// Why: "harness internals" means being able to see each step. The loop, the dispatcher and
// the checks all write here. The demo prints it live; the eval saves it to disk.
//
// Events and spans are OpenTelemetry-shaped (trace_id, span_id, parent_span_id, duration_ms and
// gen_ai.* attributes), and every HTTP call to the customer system carries a W3C `traceparent`
// header, so the customer system's own logs can be joined to the harness trace.

import { randomBytes } from "node:crypto";

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
      duration_ms?: number;
    }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "check"; name: string; ok: boolean; detail: string }
  | { kind: "inject"; field: string; value: string; source: string }
  | {
      kind: "http";
      method: string;
      path: string;
      status: number;
      traceparent?: string;
      idempotency_key?: string;
      duration_ms?: number;
    }
  | { kind: "tool_result"; id: string; is_error: boolean; content: string; duration_ms?: number }
  | { kind: "customer"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "record"; record: unknown; checks: { name: string; ok: boolean; detail: string }[]; duration_ms?: number }
  | { kind: "note"; text: string };

export type SpanAttributes = Record<string, string | number | boolean>;

export type Span = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  traceparent: string;
  name: string;
  start_ms: number;
  duration_ms: number;
  attributes: SpanAttributes;
};

// Every event is stamped with milliseconds since the conversation started, so the viewer can
// show where the time goes: model calls take seconds, the harness's own checks take microseconds.
// It also carries the span it happened in.
export type Timed<E> = E & {
  t: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  traceparent: string;
};

const roundMs = (ms: number): number => Math.round(ms * 10) / 10;
const newTraceId = (): string => randomBytes(16).toString("hex");
const newSpanId = (): string => randomBytes(8).toString("hex");

// W3C Trace Context v1: version (00) - trace-id (32 hex) - parent-id (16 hex) - trace-flags (01 = sampled).
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

type SpanFrame = { span_id: string; parent_span_id: string | null };

export class Trace {
  readonly trace_id = newTraceId();
  readonly root_span_id = newSpanId();
  readonly events: Timed<TraceEvent>[] = [];
  readonly spans: Span[] = [];
  private readonly start = performance.now();
  private readonly stack: SpanFrame[] = [{ span_id: this.root_span_id, parent_span_id: null }];

  constructor(private readonly onEvent?: (e: Timed<TraceEvent>) => void) {}

  private active(): SpanFrame {
    return this.stack[this.stack.length - 1] as SpanFrame;
  }

  currentSpanId(): string {
    return this.active().span_id;
  }

  // The header value for an outbound call made inside the current span.
  traceparent(): string {
    return formatTraceparent(this.trace_id, this.currentSpanId());
  }

  emit(e: TraceEvent): void {
    const cur = this.active();
    const timed = {
      ...e,
      t: roundMs(performance.now() - this.start),
      trace_id: this.trace_id,
      span_id: cur.span_id,
      parent_span_id: cur.parent_span_id,
      traceparent: formatTraceparent(this.trace_id, cur.span_id),
    } as Timed<TraceEvent>;
    this.events.push(timed);
    this.onEvent?.(timed);
  }

  // Runs fn inside a child span of the current one. Calls are sequential in this harness,
  // so a simple stack is enough to track the active span.
  async withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: { span_id: string; setAttributes: (extra: SpanAttributes) => void }) => Promise<T>,
  ): Promise<T> {
    const parent_span_id = this.currentSpanId();
    const span_id = newSpanId();
    const startPerf = performance.now();
    const attrs: SpanAttributes = { ...attributes };
    this.stack.push({ span_id, parent_span_id });
    try {
      return await fn({ span_id, setAttributes: (extra) => Object.assign(attrs, extra) });
    } finally {
      this.stack.pop();
      this.spans.push({
        trace_id: this.trace_id,
        span_id,
        parent_span_id,
        traceparent: formatTraceparent(this.trace_id, span_id),
        name,
        start_ms: roundMs(startPerf - this.start),
        duration_ms: roundMs(performance.now() - startPerf),
        attributes: attrs,
      });
    }
  }
}
