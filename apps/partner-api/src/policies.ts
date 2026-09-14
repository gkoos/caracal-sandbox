import {
  bulkhead,
  circuitBreaker,
  type Policy,
  retry,
  timeout,
} from "@gkoos/caracal"
import type { AppConfig } from "./config.js"
import type { CoordinatorSet } from "./coordinators.js"
import { scopeFunction } from "./scope.js"

export type PolicySet = {
  /** The pipeline, outermost first: breaker, timeout, retry, bulkhead. */
  policies: Policy[]
  breaker: Policy
  bulkhead: Policy
  coordination: "local" | "distributed"
  scopeLabel: string
  /** Local policies expose `snapshot()`; distributed state lives in Redis. */
  snapshot(): Record<string, unknown>
}

export class MissingCoordinatorError extends Error {
  constructor(policy: string) {
    super(
      `TOPOLOGY=distributed requires a coordinator, but none was supplied for "${policy}". ` +
        "Start the stack (npm run stack:up) and pass the coordinator set.",
    )
    this.name = "MissingCoordinatorError"
  }
}

/**
 * Builds the policy pipeline. This function is the only place in the workload
 * where local and distributed differ - the operations, adapters and scope keys
 * are identical in every demo.
 */
export function buildPolicies(
  config: AppConfig,
  coordinators?: CoordinatorSet,
): PolicySet {
  const scope = scopeFunction(config.scope)
  const distributed = config.topology === "distributed"
  const scopeLabel =
    config.scope === "global"
      ? "global"
      : `${config.scope}:<metadata.${config.scope === "region" ? "region" : "tenantId"}>`

  let breaker: Policy
  let capacity: Policy
  if (distributed) {
    // The guard has to live inside the branch: combined with `distributed` above
    // it narrows nothing, and TS still sees `coordinators` as possibly undefined.
    if (!coordinators) throw new MissingCoordinatorError(config.breaker.name)
    breaker = circuitBreaker.distributed({
      name: config.breaker.name,
      coordinator: coordinators.breaker,
      scope,
      minimumThroughput: config.breaker.minimumThroughput,
      failureThreshold: config.breaker.failureThreshold,
      openMs: config.breaker.openMs,
      halfOpenProbes: config.breaker.halfOpenProbes,
      halfOpenSuccesses: config.breaker.halfOpenSuccesses,
      windowSize: config.breaker.windowSize,
      onCoordinatorError: config.onCoordinatorError,
    })
    capacity = bulkhead.distributed({
      name: "partner-api-capacity",
      coordinator: coordinators.bulkhead,
      scope,
      limit: config.bulkhead.limit,
      leaseMs: config.bulkhead.leaseMs,
    })
  } else {
    breaker = circuitBreaker.local({
      name: config.breaker.name,
      minimumThroughput: config.breaker.minimumThroughput,
      failureThreshold: config.breaker.failureThreshold,
      openMs: config.breaker.openMs,
      halfOpenProbes: config.breaker.halfOpenProbes,
      halfOpenSuccesses: config.breaker.halfOpenSuccesses,
      windowSize: config.breaker.windowSize,
    })
    capacity = bulkhead.local({
      name: "partner-api-capacity",
      limit: config.bulkhead.limit,
      ...(config.bulkhead.queue ? { queue: config.bulkhead.queue } : {}),
    })
  }

  return {
    policies: [
      breaker,
      timeout({ ms: config.timeoutMs }),
      retry({
        maxAttempts: config.retry.maxAttempts,
        delay: config.retry.delayMs,
      }),
      capacity,
    ],
    breaker,
    bulkhead: capacity,
    coordination: distributed ? "distributed" : "local",
    scopeLabel,
    snapshot() {
      const localBreaker = breaker as { snapshot?: () => unknown }
      const localCapacity = capacity as { snapshot?: () => unknown }
      return {
        coordination: distributed ? "distributed" : "local",
        bulkhead:
          typeof localCapacity.snapshot === "function"
            ? localCapacity.snapshot()
            : "in redis",
        breaker:
          typeof localBreaker.snapshot === "function"
            ? localBreaker.snapshot()
            : "in redis",
      }
    },
  }
}
