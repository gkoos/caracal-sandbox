import {
  type Context,
  type Span,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api"
import type { OperationEvent } from "@gkoos/caracal"
import { type Labels, SPAN, definedLabels } from "./schema.js"

export type CaracalTracesOptions = {
  tracerName?: string
  tracerVersion?: string
  /**
   * Upper bound on tracked executions. An execution is forgotten when its
   * `execution.settled` arrives; the cap only matters if one never does, in
   * which case the span is ended and exported rather than left open.
   */
  maxTracked?: number
  /** Labels mirrored onto every span as attributes. */
  baseLabels?: Labels
}

type ExecutionRecord = {
  span: Span
  /** Context that makes later spans children of this execution. */
  parentContext: Context
  attempts: Map<number, Span>
}

/**
 * Turns the event stream into one trace per execution.
 *
 * The shape that matters: a root `caracal.execution` span, a child span per
 * attempt - so retries are visible rather than inferred from a counter - and
 * every policy decision as a span event on the execution. Taken together a
 * single call reads as "four attempts, three retryable, then the bulkhead
 * refused the fifth because the shared budget was full", without joining
 * metrics after the fact.
 *
 * Nothing here relies on an ambient active context: events arrive on whatever
 * context the caller was running in, so parenting is explicit.
 */
export class CaracalTraces {
  readonly #tracer: ReturnType<typeof trace.getTracer>
  readonly #maxTracked: number
  readonly #base: Labels
  readonly #executions = new Map<string, ExecutionRecord>()

  constructor(options: CaracalTracesOptions = {}) {
    this.#tracer = trace.getTracer(
      options.tracerName ?? "caracal-observability",
      options.tracerVersion ?? "0.0.0",
    )
    this.#maxTracked = options.maxTracked ?? 10_000
    this.#base = { ...options.baseLabels }
  }

  #attributes(labels: Labels): Record<string, string | number | boolean> {
    return definedLabels({ ...this.#base, ...labels })
  }

  /**
   * Attributes of a policy event, in `caracal.*` form. There is deliberately no
   * error or result field to map: an event carries `{ status }` only, so a trace
   * cannot quietly become a place where payloads end up.
   */
  #policyAttributes(event: OperationEvent): Labels {
    const attributes: Labels = {
      [SPAN.attribute.operation]: event.context.operationName,
    }
    if ("coordination" in event && event.coordination) {
      attributes[SPAN.attribute.coordination] = event.coordination
    }
    if ("policyName" in event && event.policyName) {
      attributes[SPAN.attribute.policy] = event.policyName
    }
    if ("scope" in event && event.scope)
      attributes[SPAN.attribute.scope] = event.scope
    if ("state" in event && event.state)
      attributes[SPAN.attribute.state] = event.state
    if ("reason" in event && event.reason)
      attributes[SPAN.attribute.reason] = event.reason
    if ("outcome" in event && event.outcome) {
      // `breaker.observation` reports a bare string here; every other event
      // carries the `EventOutcome` summary object.
      attributes[SPAN.attribute.outcome] =
        typeof event.outcome === "string" ? event.outcome : event.outcome.status
    }
    if ("classification" in event && event.classification) {
      attributes[SPAN.attribute.classification] = event.classification
    }
    if ("generation" in event && typeof event.generation === "number") {
      attributes[SPAN.attribute.generation] = event.generation
    }
    if ("occupancy" in event && typeof event.occupancy === "number") {
      attributes["caracal.occupancy"] = event.occupancy
    }
    return attributes
  }

  #track(executionId: string, record: ExecutionRecord): void {
    if (this.#executions.size >= this.#maxTracked) {
      const oldest = this.#executions.keys().next().value
      if (oldest !== undefined) this.#end(oldest, SpanStatusCode.UNSET)
    }
    this.#executions.set(executionId, record)
  }

  #end(executionId: string, code: SpanStatusCode): void {
    const record = this.#executions.get(executionId)
    if (!record) return
    this.#executions.delete(executionId)
    for (const span of record.attempts.values()) {
      span.setStatus({ code: SpanStatusCode.UNSET })
      span.end()
    }
    record.span.setStatus({ code })
    record.span.end()
  }

  record(event: OperationEvent): void {
    const { executionId, attempt, operationName } = event.context

    if (event.type === "execution.started") {
      const span = this.#tracer.startSpan(SPAN.execution, {
        attributes: this.#attributes({
          [SPAN.attribute.operation]: operationName,
        }),
      })
      span.setAttribute(SPAN.attribute.executionId, executionId)
      this.#track(executionId, {
        span,
        parentContext: trace.setSpan(context.active(), span),
        attempts: new Map(),
      })
      return
    }

    const record = this.#executions.get(executionId)

    if (event.type === "execution.settled") {
      if (!record) return
      record.span.setAttribute(SPAN.attribute.outcome, event.outcome.status)
      this.#end(
        executionId,
        event.outcome.status === "success"
          ? SpanStatusCode.OK
          : SpanStatusCode.ERROR,
      )
      return
    }

    if (event.type === "attempt.started") {
      if (!record) return
      const span = this.#tracer.startSpan(
        SPAN.attempt,
        {
          attributes: this.#attributes({
            [SPAN.attribute.operation]: operationName,
            [SPAN.attribute.attempt]: attempt,
          }),
        },
        record.parentContext,
      )
      record.attempts.set(attempt, span)
      return
    }

    if (event.type === "attempt.settled") {
      const span = record?.attempts.get(attempt)
      if (!record || !span) return
      record.attempts.delete(attempt)
      span.setAttribute(SPAN.attribute.classification, event.classification)
      span.setAttribute(SPAN.attribute.outcome, event.outcome.status)
      span.setStatus({
        code:
          event.classification === "success"
            ? SpanStatusCode.OK
            : event.classification === "ignored"
              ? SpanStatusCode.UNSET
              : SpanStatusCode.ERROR,
      })
      span.end()
      return
    }

    // Everything else is a policy decision belonging to this execution.
    record?.span.addEvent(event.type, this.#policyAttributes(event))
  }

  /** Ends anything still open, so a shutdown does not lose spans. */
  flush(): void {
    for (const executionId of [...this.#executions.keys()]) {
      this.#end(executionId, SpanStatusCode.UNSET)
    }
  }

  /** Executions currently open. Used by the smoke check to prove no leak. */
  trackedExecutions(): number {
    return this.#executions.size
  }
}
