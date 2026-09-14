import type { OperationEvent } from "@gkoos/caracal"
import type { CaracalView } from "./types.js"

/**
 * Derives the `caracal` block of a summary from the raw event stream.
 *
 * This is the client side of the comparison - what the library says happened. It
 * is kept separate from the dependency's own numbers on purpose, because a
 * demo's claim is decided on the witness, not on this.
 *
 * Events are folded in one at a time, so a long run does not have to retain the
 * stream in order to summarise it.
 */
export class EventSummarizer {
  readonly #eventsByType: Record<string, number> = {}
  readonly #executionsByOutcome: Record<string, number> = {}
  readonly #attemptsByClassification: Record<string, number> = {}
  readonly #breakerStateChanges: Record<string, number> = {}
  readonly #breakerOpensByScope: Record<string, number> = {}
  readonly #breakerRejectionsByState: Record<string, number> = {}
  readonly #bulkheadRejectionsByReason: Record<string, number> = {}
  readonly #bulkheadRejectionsByScope: Record<string, number> = {}
  readonly #peakProbesInFlightByScope: Record<string, number> = {}
  readonly #probesInFlight = new Map<string, number>()
  readonly #breakerState = new Map<string, string>()
  readonly #scopes = new Set<string>()
  /** executionId -> `bulkhead.admitted.at`, to measure how long a permit is held. */
  readonly #admittedAt = new Map<string, number>()
  readonly #permitHoldsMs: number[] = []

  #leaseLost = 0
  #degraded = 0
  #staleObservations = 0
  #coordinatorErrors = 0
  #retriesScheduled = 0
  #retriesDeclined = 0
  #timeoutsTriggered = 0
  #permitsLeaked: number | undefined

  #count(target: Record<string, number>, key: string): void {
    target[key] = (target[key] ?? 0) + 1
  }

  #probes(scope: string, next: number): void {
    const clamped = Math.max(0, next)
    this.#probesInFlight.set(scope, clamped)
    const peak = this.#peakProbesInFlightByScope[scope] ?? 0
    if (clamped > peak) this.#peakProbesInFlightByScope[scope] = clamped
  }

  record(event: OperationEvent): void {
    this.#count(this.#eventsByType, event.type)
    if ("scope" in event && event.scope) this.#scopes.add(event.scope)

    if (event.type === "execution.settled") {
      this.#count(this.#executionsByOutcome, event.outcome.status)
      return
    }
    if (event.type === "attempt.settled") {
      this.#count(this.#attemptsByClassification, event.classification)
      return
    }
    if (event.type === "retry.scheduled") {
      this.#retriesScheduled += 1
      return
    }
    if (event.type === "retry.declined") {
      this.#retriesDeclined += 1
      return
    }
    if (event.type === "timeout.triggered") {
      this.#timeoutsTriggered += 1
      return
    }
    if (event.type === "bulkhead.lease-lost") {
      this.#leaseLost += 1
      return
    }
    if (event.type === "bulkhead.admitted") {
      this.#admittedAt.set(event.context.executionId, event.at)
      return
    }
    if (event.type === "bulkhead.released") {
      const admitted = this.#admittedAt.get(event.context.executionId)
      if (admitted !== undefined) {
        this.#permitHoldsMs.push(Math.max(0, event.at - admitted))
        this.#admittedAt.delete(event.context.executionId)
      }
      return
    }
    if (event.type === "bulkhead.degraded") {
      this.#degraded += 1
      return
    }
    // A local policy reports `scope: "process"` on every event: its state is
    // per-process, so there is nothing narrower to attribute a rejection to.
    if (event.type === "bulkhead.rejected") {
      this.#count(this.#bulkheadRejectionsByReason, event.reason ?? "unknown")
      this.#count(this.#bulkheadRejectionsByScope, event.scope)
      return
    }
    if (event.type === "breaker.state-changed") {
      this.#count(this.#breakerStateChanges, event.state)
      if (event.state === "open")
        this.#count(this.#breakerOpensByScope, event.scope)
      this.#breakerState.set(event.scope, event.state)
      // Leaving half-open ends the recovery window, so whatever probe slots it
      // held are gone - which is exactly what the transition means.
      if (event.state !== "half-open") this.#probes(event.scope, 0)
      return
    }
    if (event.type === "breaker.rejected") {
      this.#count(this.#breakerRejectionsByState, event.state)
      return
    }
    if (event.type === "breaker.probe-started") {
      this.#probes(
        event.scope,
        (this.#probesInFlight.get(event.scope) ?? 0) + 1,
      )
      return
    }
    if (event.type === "breaker.observation") {
      // A settling probe frees its slot and there is no event for that, so it is
      // inferred from the state the last transition reported.
      if (this.#breakerState.get(event.scope) === "half-open") {
        this.#probes(
          event.scope,
          (this.#probesInFlight.get(event.scope) ?? 0) - 1,
        )
      }
      return
    }
    if (event.type === "breaker.observation-stale") {
      this.#staleObservations += 1
      return
    }
    if (event.type === "breaker.coordinator-error") {
      this.#coordinatorErrors += 1
    }
  }

  /** Only a demo that measures leaked permits itself should call this. */
  setPermitsLeaked(value: number): void {
    this.#permitsLeaked = value
  }

  snapshot(): CaracalView {
    const view: CaracalView = {
      executionsByOutcome: { ...this.#executionsByOutcome },
      attemptsByClassification: { ...this.#attemptsByClassification },
      eventsByType: { ...this.#eventsByType },
      breakerStateChanges: { ...this.#breakerStateChanges },
      breakerOpens: Object.values(this.#breakerOpensByScope).reduce(
        (sum, value) => sum + value,
        0,
      ),
      breakerOpensByScope: { ...this.#breakerOpensByScope },
      breakerRejectionsByState: { ...this.#breakerRejectionsByState },
      bulkheadRejectionsByReason: { ...this.#bulkheadRejectionsByReason },
      bulkheadRejectionsByScope: { ...this.#bulkheadRejectionsByScope },
      peakProbesInFlightByScope: { ...this.#peakProbesInFlightByScope },
      leaseLost: this.#leaseLost,
      degraded: this.#degraded,
      staleObservations: this.#staleObservations,
      coordinatorErrors: this.#coordinatorErrors,
      retriesScheduled: this.#retriesScheduled,
      retriesDeclined: this.#retriesDeclined,
      timeoutsTriggered: this.#timeoutsTriggered,
      distinctScopes: this.#scopes.size,
      maxPermitHoldMs: this.#permitHoldsMs.reduce(
        (max, value) => Math.max(max, value),
        0,
      ),
    }
    if (this.#permitsLeaked !== undefined)
      view.permitsLeaked = this.#permitsLeaked
    return view
  }
}

export function summarizeEvents(
  events: readonly OperationEvent[],
): CaracalView {
  const summarizer = new EventSummarizer()
  for (const event of events) summarizer.record(event)
  return summarizer.snapshot()
}

/** Highest peak across scopes: the number a "probes are bounded" claim reads. */
export function peakProbesInFlight(view: CaracalView): number {
  return Object.values(view.peakProbesInFlightByScope).reduce(
    (peak, value) => Math.max(peak, value),
    0,
  )
}
