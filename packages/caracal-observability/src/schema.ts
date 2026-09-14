/**
 * Metric and span names, plus the label vocabulary they share.
 *
 * One schema for every demo. A demo differs from another by the values in these
 * labels - `demo`, `run_id`, `scope` - not by a different set of metric names,
 * which is what lets 01 and 02 be drawn on the same Grafana panel.
 *
 * Instrument names are written without units and without a Prometheus `_total`
 * suffix being added by the collector: the name here is the name that appears in
 * Prometheus. Do not add `unit` to an instrument unless you also want the
 * collector to append a suffix.
 */

export const METRIC = {
  executions: "caracal_executions_total",
  executionDuration: "caracal_execution_duration_milliseconds",
  attempts: "caracal_attempts_total",
  attemptDuration: "caracal_attempt_duration_milliseconds",

  retryScheduled: "caracal_retry_scheduled_total",
  retryExhausted: "caracal_retry_exhausted_total",
  retryDeclined: "caracal_retry_declined_total",
  timeoutTriggered: "caracal_timeout_triggered_total",

  bulkheadAdmitted: "caracal_bulkhead_admitted_total",
  bulkheadReleased: "caracal_bulkhead_released_total",
  bulkheadRejected: "caracal_bulkhead_rejected_total",
  bulkheadWaited: "caracal_bulkhead_waited_total",
  bulkheadLeaseLost: "caracal_bulkhead_lease_lost_total",
  bulkheadDegraded: "caracal_bulkhead_degraded_total",
  bulkheadOccupancy: "caracal_bulkhead_occupancy",

  breakerStateChanges: "caracal_breaker_state_changes_total",
  breakerRejected: "caracal_breaker_rejected_total",
  breakerObservations: "caracal_breaker_observations_total",
  breakerProbesStarted: "caracal_breaker_probes_started_total",
  breakerProbesInFlight: "caracal_breaker_probes_in_flight",
  breakerStaleObservations: "caracal_breaker_stale_observations_total",
  breakerCoordinatorErrors: "caracal_breaker_coordinator_errors_total",
  breakerDegraded: "caracal_breaker_degraded_total",
  coordinatorCommands: "caracal_coordinator_commands_total",
  coordinatorErrors: "caracal_coordinator_errors_total",
} as const

/** Label names, kept in one place because the dashboards spell them out. */
export const LABEL = {
  demo: "demo",
  runId: "run_id",
  replica: "replica",
  operation: "operation",
  policy: "policy",
  coordination: "coordination",
  scope: "scope",
  state: "state",
  previousState: "previous_state",
  outcome: "outcome",
  classification: "classification",
  reason: "reason",
  behavior: "behavior",
  attempt: "attempt",
  generation: "generation",
  abortRequested: "abort_requested",
  /** `admit` | `observe` | `settle-probe` - not an operation name. */
  coordinatorOperation: "coordinator_operation",
  /** `eval` | `evalsha` | `hmget` - the Redis command a coordinator call used. */
  command: "command",
} as const

export type LabelValue = string | number | boolean | undefined

/** Labels attached to every measurement, and to span attributes. */
export type Labels = Record<string, LabelValue>

/** Span names and attribute keys. */
export const SPAN = {
  execution: "caracal.execution",
  attempt: "caracal.attempt",
  attribute: {
    operation: "caracal.operation",
    executionId: "caracal.execution_id",
    attempt: "caracal.attempt",
    scope: "caracal.scope",
    policy: "caracal.policy",
    coordination: "caracal.coordination",
    outcome: "caracal.outcome",
    classification: "caracal.classification",
    reason: "caracal.reason",
    state: "caracal.state",
    generation: "caracal.generation",
  },
} as const

/**
 * `scope` is the label a distributed policy resolves per execution, so its
 * cardinality is whatever the application's scope function produces. A tenant
 * scope can be thousands of values, and thousands of label values in Prometheus
 * is an operational problem rather than a detail.
 *
 * Set `CARACAL_SCOPE_LABEL=off` to drop the label from every metric while
 * keeping it on spans, where high cardinality costs storage rather than memory.
 * Once a scope is a metric label it cannot be removed retroactively, so the
 * switch exists from the first run rather than being bolted on later.
 */
export function scopeLabelEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = (env.CARACAL_SCOPE_LABEL ?? "on").toLowerCase()
  return value !== "off" && value !== "false" && value !== "0"
}

/** Drops `undefined` so a missing optional field does not become a label. */
export function definedLabels(
  labels: Labels,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) result[key] = value
  }
  return result
}
