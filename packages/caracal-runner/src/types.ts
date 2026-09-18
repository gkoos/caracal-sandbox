/**
 * The shape every demo run writes.
 *
 * One schema, four sources of truth:
 *
 * - `client`   - what the traffic driver saw: outcomes, refusals, latency.
 * - `witness`  - what the dependency saw: its own in-flight count. This is the
 *                number a claim is decided on, because it does not come from the
 *                library being demonstrated.
 * - `caracal`  - what the library reported through events, summarised.
 * - `coordination` - what the fleet spent talking to the coordinator.
 *
 * A `summary.json` is written even when checks fail: the artifact of a failing
 * run is often the interesting one.
 */

export type CheckResult = {
  name: string
  /** Human-readable statement of what was asserted. */
  claim: string
  expected: string
  actual: string
  passed: boolean
  detail?: string
}

export type LatencyMs = {
  p50: number
  p95: number
  p99: number
  max: number
}

export type Topology = {
  policies: "local" | "distributed"
  /** The scope function in words: `global`, `region:<region>`, `tenant:<id>`. */
  scope: string
  /** Anything else that changes behaviour and should be visible next to numbers. */
  config: Record<string, string | number | boolean>
}

export type ClientView = {
  requests: number
  success: number
  failure: number
  /** Refusals and timeouts, keyed by the reason the caller saw. */
  refusedByReason: Record<string, number>
  timedOut: number
  latencyMs: LatencyMs
  rps: number
}

export type WitnessView = {
  /** Timeline samples the dependency took of its own concurrency. */
  samples: number
  peakInFlight: number
  /** Highest 1-second arrival rate the dependency measured about itself. */
  peakRps?: number
  peakByScope: Record<string, number>
  requests: number
  failures: number
  /** Responses the client abandoned before the body was written (dispose). */
  abandoned?: number
  /** The dependency's configured ceiling, when it has one. */
  capacity?: number
}

export type CaracalView = {
  /** `execution.settled` by outcome. */
  executionsByOutcome: Record<string, number>
  /** `attempt.settled` by classification. */
  attemptsByClassification: Record<string, number>
  /** Raw event counts by type - the ground truth for "did this happen at all". */
  eventsByType: Record<string, number>
  breakerStateChanges: Record<string, number>
  breakerOpens: number
  breakerOpensByScope: Record<string, number>
  breakerRejectionsByState: Record<string, number>
  bulkheadRejectionsByReason: Record<string, number>
  bulkheadRejectionsByScope: Record<string, number>
  /** `ratelimit.admitted` count. */
  rateLimitAdmitted: number
  /** `ratelimit.rejected` by reason (`rate-exceeded`, `coordinator-unavailable`). */
  rateLimitRejectionsByReason: Record<string, number>
  /** `ratelimit.rejected` by scope. */
  rateLimitRejectionsByScope: Record<string, number>
  /** Longest `retryAfterMs` a `rate-exceeded` rejection carried. */
  rateLimitRetryAfterMaxMs: number
  /** Highest number of half-open probes believed in flight at once, per scope. */
  peakProbesInFlightByScope: Record<string, number>
  leaseLost: number
  degraded: number
  staleObservations: number
  coordinatorErrors: number
  retriesScheduled: number
  retriesDeclined: number
  timeoutsTriggered: number
  /** Distinct scope keys the stream saw - the cardinality the tenant demo measures. */
  distinctScopes: number
  /** Longest time between `bulkhead.admitted` and `bulkhead.released` (ms). */
  maxPermitHoldMs: number
  /** Filled by a demo that can measure it (chaos); absent otherwise. */
  permitsLeaked?: number
}

export type CoordinationView = {
  commands: number
  evalsha: number
  eval: number
  errors: number
  roundTripsPerExecution: number
}

/** The chaos demo's witness: the live lease count sampled from Redis itself. */
export type ChaosView = {
  samples: number
  /** Highest live (non-expired) lease count observed, across all bulkhead keys. */
  maxLiveLeases: number
  /** Live lease count at the very end, after the run settled - 0 means no leak. */
  finalLiveLeases: number
  /** The chaos actions that actually fired, for provenance. */
  actions: string[]
  /** The shared limit the invariant is stated against. */
  limit: number
}

export type Summary = {
  schema: 1
  runId: string
  demo: string
  title: string
  startedAt: string
  finishedAt: string
  /** Which caracal produced these numbers - the version is part of the result. */
  library: { version: string; source: string }
  topology: Topology
  workload: {
    durationMs: number
    concurrency: number
    targetRpsPerReplica?: number
    replicas: number
    byOperation: Record<string, number>
  }
  client: ClientView
  witness?: WitnessView
  caracal: CaracalView
  coordination?: CoordinationView
  chaos?: ChaosView
  checks: CheckResult[]
  passed: boolean
  notes: string[]
}
