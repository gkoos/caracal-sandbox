import {
  bulkhead,
  circuitBreaker,
  type Policy,
  rateLimit,
  retry,
  timeout,
} from "@gkoos/caracal"
import type { AppConfig } from "./config.js"
import type { CoordinatorSet, ServalSet } from "./coordinators.js"
import { scopeFunction } from "./scope.js"

/** The identity names the coordinator and the ramp controller must agree on. */
export const BULKHEAD_POLICY_NAME = "partner-api-capacity"
export const RATE_POLICY_NAME = "partner-api-rate"

export type PolicySet = {
  /** The pipeline, outermost first: breaker, timeout, retry, bulkhead, rate. */
  policies: Policy[]
  breaker: Policy
  bulkhead: Policy
  /** Present only when a rate limit was configured. */
  rate: Policy | undefined
  coordination: "local" | "distributed" | "serval"
  scopeLabel: string
  /** Policy names, so a controller addresses the same identity the policy uses. */
  bulkheadName: string
  rateName: string
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
  delegated?: ServalSet,
): PolicySet {
  const scope = scopeFunction(config.scope)
  const distributed = config.topology === "distributed"
  const serval = config.topology === "serval"
  const scopeLabel =
    config.scope === "global"
      ? "global"
      : `${config.scope}:<metadata.${config.scope === "region" ? "region" : "tenantId"}>`

  let breaker: Policy
  let capacity: Policy
  if (serval) {
    // Delegated: each replica holds a bounded piece of the fleet's authority and
    // enforces it locally, so most admissions never reach Redis at all. The
    // coordinator argument is the delegated one - the strict coordinator is its
    // authority, one layer down.
    if (!delegated) throw new MissingCoordinatorError(config.breaker.name)
    breaker = circuitBreaker.distributed({
      name: config.breaker.name,
      coordinator: delegated.breaker,
      scope,
      minimumThroughput: config.breaker.minimumThroughput,
      failureThreshold: config.breaker.failureThreshold,
      openMs: config.breaker.openMs,
      halfOpenProbes: config.breaker.halfOpenProbes,
      halfOpenSuccesses: config.breaker.halfOpenSuccesses,
      windowSize: config.breaker.windowSize,
      probeLeaseTtlMs: config.breaker.probeLeaseTtlMs,
      onCoordinatorError: config.onCoordinatorError,
    })
    capacity = bulkhead.distributed({
      name: BULKHEAD_POLICY_NAME,
      coordinator: delegated.bulkhead,
      scope,
      limit: config.bulkhead.limit,
      leaseMs: config.bulkhead.leaseMs,
    })
  } else if (distributed) {
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
      probeLeaseTtlMs: config.breaker.probeLeaseTtlMs,
      onCoordinatorError: config.onCoordinatorError,
    })
    capacity = bulkhead.distributed({
      name: BULKHEAD_POLICY_NAME,
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
      probeLeaseTtlMs: config.breaker.probeLeaseTtlMs,
    })
    capacity = bulkhead.local({
      name: BULKHEAD_POLICY_NAME,
      limit: config.bulkhead.limit,
      leaseMs: config.bulkhead.leaseMs,
      ...(config.bulkhead.queue ? { queue: config.bulkhead.queue } : {}),
    })
  }

  // The rate limiter is the axis next to the bulkhead's concurrency axis. It is
  // an *additional* policy: when configured, it sits innermost and bounds how
  // fast calls start, whatever the concurrency budget is doing.
  let rate: Policy | undefined
  if (config.rateLimit.rate > 0) {
    if (serval) {
      if (!delegated) throw new MissingCoordinatorError("partner-api-rate")
      rate = rateLimit.distributed({
        name: RATE_POLICY_NAME,
        coordinator: delegated.rateLimit,
        scope,
        rate: config.rateLimit.rate,
        burst: config.rateLimit.burst,
      })
    } else if (distributed) {
      if (!coordinators) throw new MissingCoordinatorError("partner-api-rate")
      rate = rateLimit.distributed({
        name: RATE_POLICY_NAME,
        coordinator: coordinators.rateLimit,
        scope,
        rate: config.rateLimit.rate,
        burst: config.rateLimit.burst,
      })
    } else {
      rate = rateLimit.local({
        name: RATE_POLICY_NAME,
        rate: config.rateLimit.rate,
        burst: config.rateLimit.burst,
      })
    }
  }

  // The optional per-process ceiling, composed innermost - and deliberately a
  // *local* policy even under a coordinator. The delegated layers are approximate
  // by design; this is the bound that holds when the coordinator does not answer.
  // Innermost means it sees only the calls that passed every other layer, so it
  // caps what actually reaches the dependency.
  const ceiling =
    config.localCeiling > 0
      ? bulkhead.local({
          name: `${BULKHEAD_POLICY_NAME}-local`,
          limit: config.localCeiling,
          leaseMs: config.bulkhead.leaseMs,
        })
      : undefined

  return {
    policies: [
      breaker,
      timeout({ ms: config.timeoutMs }),
      retry({
        maxAttempts: config.retry.maxAttempts,
        delay: config.retry.delayMs,
      }),
      capacity,
      ...(rate ? [rate] : []),
      ...(ceiling ? [ceiling] : []),
    ],
    breaker,
    bulkhead: capacity,
    rate,
    coordination: serval ? "serval" : distributed ? "distributed" : "local",
    scopeLabel,
    bulkheadName: BULKHEAD_POLICY_NAME,
    rateName: RATE_POLICY_NAME,
    snapshot() {
      const localBreaker = breaker as { snapshot?: () => unknown }
      const localCapacity = capacity as { snapshot?: () => unknown }
      const localRate = rate as { snapshot?: () => unknown } | undefined
      return {
        coordination: serval ? "serval" : distributed ? "distributed" : "local",
        bulkhead:
          typeof localCapacity.snapshot === "function"
            ? localCapacity.snapshot()
            : "in redis",
        breaker:
          typeof localBreaker.snapshot === "function"
            ? localBreaker.snapshot()
            : "in redis",
        rate:
          localRate && typeof localRate.snapshot === "function"
            ? localRate.snapshot()
            : rate
              ? "in redis"
              : "off",
      }
    },
  }
}
