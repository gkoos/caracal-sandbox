import {
  type Counter,
  type Histogram,
  metrics,
  type UpDownCounter,
} from "@opentelemetry/api"
import type { OperationEvent } from "@gkoos/caracal"
import {
  type Labels,
  LABEL,
  METRIC,
  definedLabels,
  scopeLabelEnabled,
} from "./schema.js"

export type CaracalMetricsOptions = {
  /** Labels on every measurement: demo, run_id, replica. */
  baseLabels?: Labels
  /** Instrumentation scope name. */
  meterName?: string
  meterVersion?: string
  /**
   * Upper bound on the bookkeeping maps that turn start/settle pairs into
   * durations. Reached only if a settlement is lost, which the runtime does not
   * do - the cap is here so that if it ever happened the numbers would degrade
   * rather than the process.
   */
  maxTracked?: number
}

/**
 * Reconstructs Prometheus-facing metrics from caracal's event stream.
 *
 * Two properties of that stream shape this class:
 *
 * - Events carry no payload, only `{ status }`, so nothing here can leak a
 *   response body or an error message into a label.
 * - `emit` is fire-and-forget: `record` must not throw and must not block.
 *   Everything below is a synchronous map update plus an instrument write.
 */
export class CaracalMetrics {
  readonly #base: Labels
  readonly #maxTracked: number

  readonly #executions: Counter
  readonly #executionDuration: Histogram
  readonly #attempts: Counter
  readonly #attemptDuration: Histogram
  readonly #retryScheduled: Counter
  readonly #retryExhausted: Counter
  readonly #retryDeclined: Counter
  readonly #timeoutTriggered: Counter
  readonly #bulkheadAdmitted: Counter
  readonly #bulkheadReleased: Counter
  readonly #bulkheadRejected: Counter
  readonly #bulkheadWaited: Counter
  readonly #bulkheadLeaseLost: Counter
  readonly #bulkheadDegraded: Counter
  readonly #bulkheadOccupancy: UpDownCounter
  readonly #breakerStateChanges: Counter
  readonly #breakerRejected: Counter
  readonly #breakerObservations: Counter
  readonly #breakerProbesStarted: Counter
  readonly #breakerProbesInFlight: UpDownCounter
  readonly #breakerStaleObservations: Counter
  readonly #breakerCoordinatorErrors: Counter
  readonly #breakerDegraded: Counter
  readonly #coordinatorCommands: Counter
  readonly #coordinatorErrors: Counter

  /** executionId -> start time, taken from `execution.started.at`. */
  readonly #executionStartedAt = new Map<string, number>()
  /** `${executionId}:${attempt}` -> start time, from `attempt.started.at`. */
  readonly #attemptStartedAt = new Map<string, number>()
  /** policy|operation|scope -> last occupancy a coordinator reported. */
  readonly #occupancy = new Map<string, number>()
  /** policy|operation|scope -> last state the breaker reported. */
  readonly #breakerState = new Map<string, string>()

  constructor(options: CaracalMetricsOptions = {}) {
    this.#base = { ...options.baseLabels }
    this.#maxTracked = options.maxTracked ?? 20_000
    const meter = metrics.getMeter(
      options.meterName ?? "caracal-observability",
      options.meterVersion ?? "0.0.0",
    )

    this.#executions = meter.createCounter(METRIC.executions)
    this.#executionDuration = meter.createHistogram(METRIC.executionDuration)
    this.#attempts = meter.createCounter(METRIC.attempts)
    this.#attemptDuration = meter.createHistogram(METRIC.attemptDuration)
    this.#retryScheduled = meter.createCounter(METRIC.retryScheduled)
    this.#retryExhausted = meter.createCounter(METRIC.retryExhausted)
    this.#retryDeclined = meter.createCounter(METRIC.retryDeclined)
    this.#timeoutTriggered = meter.createCounter(METRIC.timeoutTriggered)
    this.#bulkheadAdmitted = meter.createCounter(METRIC.bulkheadAdmitted)
    this.#bulkheadReleased = meter.createCounter(METRIC.bulkheadReleased)
    this.#bulkheadRejected = meter.createCounter(METRIC.bulkheadRejected)
    this.#bulkheadWaited = meter.createCounter(METRIC.bulkheadWaited)
    this.#bulkheadLeaseLost = meter.createCounter(METRIC.bulkheadLeaseLost)
    this.#bulkheadDegraded = meter.createCounter(METRIC.bulkheadDegraded)
    this.#bulkheadOccupancy = meter.createUpDownCounter(
      METRIC.bulkheadOccupancy,
    )
    this.#breakerStateChanges = meter.createCounter(METRIC.breakerStateChanges)
    this.#breakerRejected = meter.createCounter(METRIC.breakerRejected)
    this.#breakerObservations = meter.createCounter(METRIC.breakerObservations)
    this.#breakerProbesStarted = meter.createCounter(
      METRIC.breakerProbesStarted,
    )
    this.#breakerProbesInFlight = meter.createUpDownCounter(
      METRIC.breakerProbesInFlight,
    )
    this.#breakerStaleObservations = meter.createCounter(
      METRIC.breakerStaleObservations,
    )
    this.#breakerCoordinatorErrors = meter.createCounter(
      METRIC.breakerCoordinatorErrors,
    )
    this.#breakerDegraded = meter.createCounter(METRIC.breakerDegraded)
    this.#coordinatorCommands = meter.createCounter(METRIC.coordinatorCommands)
    this.#coordinatorErrors = meter.createCounter(METRIC.coordinatorErrors)
  }

  /** policy|operation|scope -> probe slots believed in use. */
  readonly #probesInFlight = new Map<string, number>()

  #labels(event: OperationEvent, extra: Labels = {}): Labels {
    const labels: Labels = {
      ...this.#base,
      [LABEL.operation]: event.context.operationName,
    }
    if ("coordination" in event && event.coordination) {
      labels[LABEL.coordination] = event.coordination
    }
    if ("policyName" in event && event.policyName) {
      labels[LABEL.policy] = event.policyName
    }
    if ("scope" in event && event.scope && scopeLabelEnabled()) {
      labels[LABEL.scope] = event.scope
    }
    return { ...labels, ...extra }
  }

  #count(counter: Counter, labels: Labels, extra: Labels = {}): void {
    counter.add(1, definedLabels({ ...labels, ...extra }))
  }

  #track(map: Map<string, number>, mapKey: string, value: number): void {
    if (map.size >= this.#maxTracked) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(mapKey, value)
  }

  /** Delta between a start the stream recorded and the settle it belongs to. */
  #duration(
    map: Map<string, number>,
    mapKey: string,
    at: number,
  ): number | undefined {
    const start = map.get(mapKey)
    if (start === undefined) return undefined
    map.delete(mapKey)
    return Math.max(0, at - start)
  }

  /** Identity a gauge is reconciled against, without the volatile labels. */
  #key(labels: Labels): string {
    return [
      labels[LABEL.policy],
      labels[LABEL.operation],
      labels[LABEL.scope],
    ].join("|")
  }

  /**
   * Moves the occupancy gauge to an absolute value a coordinator reported.
   *
   * Occupancy is reported rather than counted, so a release that never arrives
   * is corrected by the next event instead of leaving the gauge offset for the
   * life of the process.
   */
  #setOccupancy(labels: Labels, mapKey: string, reported: number): void {
    const previous = this.#occupancy.get(mapKey) ?? 0
    const next = Math.max(0, reported)
    if (next === previous) return
    this.#bulkheadOccupancy.add(next - previous, definedLabels(labels))
    this.#track(this.#occupancy, mapKey, next)
  }

  #probes(labels: Labels, mapKey: string, next: number): void {
    const previous = this.#probesInFlight.get(mapKey) ?? 0
    const clamped = Math.max(0, next)
    if (clamped === previous) return
    this.#breakerProbesInFlight.add(clamped - previous, definedLabels(labels))
    this.#track(this.#probesInFlight, mapKey, clamped)
  }

  #recordOccupancy(event: OperationEvent, labels: Labels): void {
    if (!("occupancy" in event) || typeof event.occupancy !== "number") return
    this.#setOccupancy(labels, this.#key(labels), event.occupancy)
  }

  /**
   * Entry point for an event sink. Narrowing is done by `type` comparisons
   * rather than a switch so that each group can be defined as its own method.
   */
  record(event: OperationEvent): void {
    const { executionId, attempt } = event.context
    const labels = this.#labels(event)

    if (event.type === "execution.started") {
      this.#track(this.#executionStartedAt, executionId, event.at)
      return
    }
    if (event.type === "execution.settled") {
      this.#count(this.#executions, labels, {
        [LABEL.outcome]: event.outcome.status,
      })
      const duration = this.#duration(
        this.#executionStartedAt,
        executionId,
        event.at,
      )
      if (duration !== undefined) {
        this.#executionDuration.record(duration, definedLabels(labels))
      }
      return
    }
    if (event.type === "attempt.started") {
      this.#track(this.#attemptStartedAt, `${executionId}:${attempt}`, event.at)
      return
    }
    if (event.type === "attempt.settled") {
      const classified: Labels = {
        [LABEL.classification]: event.classification,
      }
      this.#count(this.#attempts, labels, classified)
      const duration = this.#duration(
        this.#attemptStartedAt,
        `${executionId}:${attempt}`,
        event.at,
      )
      if (duration !== undefined) {
        this.#attemptDuration.record(
          duration,
          definedLabels({ ...labels, ...classified }),
        )
      }
      return
    }
    if (event.type === "timeout.triggered") {
      this.#count(this.#timeoutTriggered, labels, {
        [LABEL.abortRequested]: event.abortRequested,
      })
      return
    }
    if (event.type === "retry.scheduled") {
      this.#count(this.#retryScheduled, labels, {
        [LABEL.classification]: event.classification,
      })
      return
    }
    if (event.type === "retry.exhausted") {
      this.#count(this.#retryExhausted, labels)
      return
    }
    if (event.type === "retry.declined") {
      this.#count(this.#retryDeclined, labels, { [LABEL.reason]: event.reason })
      return
    }

    this.#recordBulkhead(event, labels)
  }

  #recordBulkhead(event: OperationEvent, labels: Labels): void {
    if (event.type === "bulkhead.admitted") {
      this.#count(this.#bulkheadAdmitted, labels)
      this.#recordOccupancy(event, labels)
      return
    }
    if (event.type === "bulkhead.released") {
      this.#count(this.#bulkheadReleased, labels, {
        [LABEL.reason]: event.reason,
      })
      this.#recordOccupancy(event, labels)
      return
    }
    if (event.type === "bulkhead.rejected") {
      this.#count(this.#bulkheadRejected, labels, {
        [LABEL.reason]: event.reason,
      })
      this.#recordOccupancy(event, labels)
      return
    }
    if (event.type === "bulkhead.waited") {
      this.#count(this.#bulkheadWaited, labels)
      this.#recordOccupancy(event, labels)
      return
    }
    if (event.type === "bulkhead.lease-lost") {
      this.#count(this.#bulkheadLeaseLost, labels)
      // The permit is gone whether or not a release ever arrives. The next
      // reported occupancy corrects any error this introduces.
      const mapKey = this.#key(labels)
      this.#setOccupancy(labels, mapKey, (this.#occupancy.get(mapKey) ?? 1) - 1)
      return
    }
    if (event.type === "bulkhead.degraded") {
      this.#count(this.#bulkheadDegraded, labels, {
        [LABEL.reason]: event.reason,
      })
      return
    }

    this.#recordBreaker(event, labels)
  }

  #recordBreaker(event: OperationEvent, labels: Labels): void {
    if (event.type === "breaker.state-changed") {
      const mapKey = this.#key(labels)
      this.#count(this.#breakerStateChanges, labels, {
        [LABEL.state]: event.state,
        [LABEL.previousState]: event.previousState,
      })
      this.#breakerState.set(mapKey, event.state)
      // Leaving half-open ends a recovery window, so every probe slot the
      // window still held is released - that is what the transition means.
      if (event.state !== "half-open") this.#probes(labels, mapKey, 0)
      return
    }
    if (event.type === "breaker.rejected") {
      this.#count(this.#breakerRejected, labels, { [LABEL.state]: event.state })
      return
    }
    if (event.type === "breaker.probe-started") {
      const mapKey = this.#key(labels)
      this.#count(this.#breakerProbesStarted, labels)
      this.#probes(labels, mapKey, (this.#probesInFlight.get(mapKey) ?? 0) + 1)
      return
    }
    if (event.type === "breaker.observation") {
      const mapKey = this.#key(labels)
      this.#count(this.#breakerObservations, labels, {
        [LABEL.outcome]: event.outcome,
      })
      // A settling probe frees its slot, and there is no event for that: it is
      // inferred from the state the last transition reported.
      if (this.#breakerState.get(mapKey) === "half-open") {
        this.#probes(
          labels,
          mapKey,
          (this.#probesInFlight.get(mapKey) ?? 0) - 1,
        )
      }
      return
    }
    if (event.type === "breaker.observation-stale") {
      // Deliberately not labelled with the two generations: the useful signal is
      // that an observation was dropped, and each generation pair would be a new
      // label value per epoch. Both numbers travel on the span instead.
      this.#count(this.#breakerStaleObservations, labels)
      return
    }
    if (event.type === "breaker.coordinator-error") {
      this.#count(this.#breakerCoordinatorErrors, labels, {
        [LABEL.coordinatorOperation]: event.operation,
      })
      return
    }
    if (event.type === "breaker.degraded") {
      this.#count(this.#breakerDegraded, labels, {
        [LABEL.reason]: event.reason,
        [LABEL.behavior]: event.behavior,
      })
    }
  }

  /**
   * Records one coordinator command, for the round-trips and EVALSHA-ratio panels.
   * These are not events - they are counted where the coordinator is called - so
   * they are recorded directly rather than through the event sink.
   */
  recordCoordinatorCommand(kind: "eval" | "evalsha" | "hmget"): void {
    this.#count(this.#coordinatorCommands, this.#base, {
      [LABEL.command]: kind,
    })
  }

  /** Records a coordinator error, for the degraded-coordination panel. */
  recordCoordinatorError(): void {
    this.#count(this.#coordinatorErrors, this.#base)
  }

  /**
   * Forgets the gauges reconciled from events. Replicas are long-lived processes
   * across demos, so a run boundary has to say what a new run counts from.
   */
  reset(): void {
    this.#executionStartedAt.clear()
    this.#attemptStartedAt.clear()
    this.#occupancy.clear()
    this.#breakerState.clear()
    this.#probesInFlight.clear()
  }
}
