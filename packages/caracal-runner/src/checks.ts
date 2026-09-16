import { peakProbesInFlight } from "./events.js"
import type { CheckResult, Summary } from "./types.js"

export type CheckParams = Record<string, unknown>

export type CheckDefinition = {
  name: string
  /** What the check asserts, with its parameters substituted in. */
  claim(params: CheckParams): string
  /** One line on why the check exists. Optional for the obvious ones. */
  description?: string
  evaluate(
    summary: Summary,
    params: CheckParams,
  ): { expected: string; actual: string; passed: boolean; detail?: string }
}

export type CheckSpec = { name: string; params?: CheckParams }

const MISSING = "missing"

function number(params: CheckParams, key: string): number {
  const value = params[key]
  if (typeof value !== "number") {
    throw new Error(`check parameter \`${key}\` must be a number`)
  }
  return value
}

function text(params: CheckParams, key: string): string {
  const value = params[key]
  if (typeof value !== "string") {
    throw new Error(`check parameter \`${key}\` must be a string`)
  }
  return value
}

/** Compares a measured value against a threshold; a missing value fails. */
function compare(
  actual: number | undefined,
  expected: number,
  predicate: (actual: number, expected: number) => boolean,
  unit = "",
): { expected: string; actual: string; passed: boolean } {
  if (actual === undefined) {
    return { expected: `${expected}${unit}`, actual: MISSING, passed: false }
  }
  return {
    expected: `${expected}${unit}`,
    actual: `${actual}${unit}`,
    passed: predicate(actual, expected),
  }
}

/**
 * The named checks a study's `study.yaml` can ask for.
 *
 * Named and registered rather than evaluated as expressions: a typo in a check
 * name fails the run loudly, and each check can be reasoned about on its own. A
 * check whose input is absent fails rather than passing quietly, which is the
 * point - a demo that cannot fail is theatre.
 */
export const CHECKS: Record<string, CheckDefinition> = {
  witnessPresent: {
    name: "witnessPresent",
    claim: () => "the dependency reported its own concurrency",
    description:
      "Without an independent number there is nothing to decide a claim on.",
    evaluate: (summary) => ({
      expected: "present",
      actual: summary.witness ? "present" : MISSING,
      passed: Boolean(summary.witness),
    }),
  },
  witnessSamplesAtLeast: {
    name: "witnessSamplesAtLeast",
    claim: (params) =>
      `the dependency took at least ${number(params, "value")} samples`,
    description: "A witness with too few samples is not evidence.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.samples,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  peakInFlightAtMost: {
    name: "peakInFlightAtMost",
    claim: (params) =>
      `the dependency never saw more than ${number(params, "value")} concurrent calls`,
    description:
      "The headline claim: a scope is a ceiling on the dependency, not a per-process one.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.peakInFlight,
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  peakInFlightAtLeast: {
    name: "peakInFlightAtLeast",
    claim: (params) =>
      `the dependency saw at least ${number(params, "value")} concurrent calls`,
    description:
      "Used by the local demos, where the point is that the limit multiplied.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.peakInFlight,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  peakInFlightInScopeAtMost: {
    name: "peakInFlightInScopeAtMost",
    claim: (params) =>
      `scope \`${text(params, "scope")}\` never exceeded ${number(params, "value")} concurrent calls`,
    description: "Per-scope ceilings: what a scoped policy actually promises.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.peakByScope?.[text(params, "scope")],
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  breakerOpensEquals: {
    name: "breakerOpensEquals",
    claim: (params) =>
      `the failure opened the breaker exactly ${number(params, "value")} time(s)`,
    description:
      "Four replicas with local breakers open four times; one distributed breaker opens once.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.breakerOpens,
        number(params, "value"),
        (a, e) => a === e,
      ),
  },
  breakerOpensAtMost: {
    name: "breakerOpensAtMost",
    claim: (params) =>
      `the breaker opened at most ${number(params, "value")} time(s)`,
    evaluate: (summary, params) =>
      compare(
        summary.caracal.breakerOpens,
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  breakerOpensInScopeAtLeast: {
    name: "breakerOpensInScopeAtLeast",
    claim: (params) =>
      `scope \`${text(params, "scope")}\` opened its breaker at least ${number(params, "value")} time(s)`,
    description:
      "Blast radius: the broken scope is the one that tripped its breaker.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.breakerOpensByScope[text(params, "scope")] ?? 0,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  breakerOpensInScopeEquals: {
    name: "breakerOpensInScopeEquals",
    claim: (params) =>
      `scope \`${text(params, "scope")}\` opened its breaker exactly ${number(params, "value")} time(s)`,
    description:
      "Blast radius: an untouched scope must not open a breaker the failing scope did.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.breakerOpensByScope[text(params, "scope")] ?? 0,
        number(params, "value"),
        (a, e) => a === e,
      ),
  },
  scopesThatOpenedEquals: {
    name: "scopesThatOpenedEquals",
    claim: (params) =>
      `exactly ${number(params, "value")} scope(s) opened a breaker`,
    description:
      "Blast radius in one number: how many failure domains actually tripped.",
    evaluate: (summary, params) =>
      compare(
        Object.values(summary.caracal.breakerOpensByScope).filter(
          (count) => count >= 1,
        ).length,
        number(params, "value"),
        (a, e) => a === e,
      ),
  },
  distinctScopesAtLeast: {
    name: "distinctScopesAtLeast",
    claim: (params) =>
      `the stream touched at least ${number(params, "value")} distinct scope(s)`,
    description:
      "Cardinality, made visible: each scope is a coordination key (and, by default, a metric label value).",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.distinctScopes,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  permitHoldAtLeast: {
    name: "permitHoldAtLeast",
    claim: (params) =>
      `a permit was held for at least ${number(params, "value")}ms`,
    description:
      '`abort: "unsupported"` in one number: a timed-out query keeps its permit for the full query duration, not the timeout.',
    evaluate: (summary, params) =>
      compare(
        summary.caracal.maxPermitHoldMs,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  maxLiveLeasesAtMost: {
    name: "maxLiveLeasesAtMost",
    claim: (params) => `live leases never exceeded ${number(params, "value")}`,
    description:
      "The invariant the library exists for: chaos never over-admits, sampled on the coordinator's own clock.",
    evaluate: (summary, params) =>
      compare(
        summary.chaos?.maxLiveLeases,
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  finalLiveLeasesEquals: {
    name: "finalLiveLeasesEquals",
    claim: (params) =>
      `exactly ${number(params, "value")} lease(s) outlived the run`,
    description:
      "No leak: every permit was released or expired by the time the run settled.",
    evaluate: (summary, params) =>
      compare(
        summary.chaos?.finalLiveLeases,
        number(params, "value"),
        (a, e) => a === e,
      ),
  },
  chaosSamplesAtLeast: {
    name: "chaosSamplesAtLeast",
    claim: (params) =>
      `the sampler took at least ${number(params, "value")} lease sample(s)`,
    description: "A witness with too few samples is not evidence.",
    evaluate: (summary, params) =>
      compare(
        summary.chaos?.samples,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  peakProbesAtMost: {
    name: "peakProbesAtMost",
    claim: (params) =>
      `at most ${number(params, "value")} half-open probe(s) were in flight at once`,
    description:
      "Probes are arbitrated in the coordinator, so the bound is fleet-wide, not per-replica.",
    evaluate: (summary, params) =>
      compare(
        peakProbesInFlight(summary.caracal),
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  peakProbesAtLeast: {
    name: "peakProbesAtLeast",
    claim: (params) =>
      `at least ${number(params, "value")} probe(s) were in flight at once`,
    description: "Recovery was actually exercised rather than never attempted.",
    evaluate: (summary, params) =>
      compare(
        peakProbesInFlight(summary.caracal),
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  leakedPermitsEquals: {
    name: "leakedPermitsEquals",
    claim: (params) =>
      `exactly ${number(params, "value")} permit(s) outlived the run`,
    description:
      "Admitted minus released minus lost, measured by the demo. A leaked permit is capacity nobody can use.",
    evaluate: (summary, params) => ({
      ...compare(
        summary.caracal.permitsLeaked,
        number(params, "value"),
        (a, e) => a === e,
      ),
      detail: "summaries that measure permits directly set this field",
    }),
  },
  noRejectionsInScope: {
    name: "noRejectionsInScope",
    claim: (params) => `scope \`${text(params, "scope")}\` rejected nothing`,
    description:
      "Blast-radius containment: a failure in one scope must not shed another.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.bulkheadRejectionsByScope[text(params, "scope")] ?? 0,
        0,
        (a, e) => a === e,
      ),
  },
  successRateAtLeast: {
    name: "successRateAtLeast",
    claim: (params) =>
      `at least ${Math.round(number(params, "value") * 100)}% of calls succeeded`,
    evaluate: (summary, params) => {
      const { requests, success } = summary.client
      if (requests === 0) {
        return {
          expected: "more than 0 requests",
          actual: "0 requests",
          passed: false,
        }
      }
      const rate = success / requests
      return {
        expected: `>= ${(number(params, "value") * 100).toFixed(0)}%`,
        actual: `${(rate * 100).toFixed(1)}%`,
        passed: rate >= number(params, "value"),
      }
    },
  },
  requestsAtLeast: {
    name: "requestsAtLeast",
    claim: (params) =>
      `the run issued at least ${number(params, "value")} requests`,
    description:
      "A run that produced no load cannot support a claim about behaviour under load.",
    evaluate: (summary, params) =>
      compare(
        summary.client.requests,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  refusedAtMost: {
    name: "refusedAtMost",
    claim: (params) =>
      `at most ${number(params, "value")} call(s) were refused by a policy`,
    evaluate: (summary, params) => {
      const refused = Object.values(summary.client.refusedByReason).reduce(
        (sum, value) => sum + value,
        0,
      )
      return compare(refused, number(params, "value"), (a, e) => a <= e)
    },
  },
  timeoutsAtLeast: {
    name: "timeoutsAtLeast",
    claim: (params) =>
      `at least ${number(params, "value")} deadline(s) expired`,
    evaluate: (summary, params) =>
      compare(
        summary.client.timedOut,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  retriesDeclinedAtLeast: {
    name: "retriesDeclinedAtLeast",
    claim: (params) =>
      `retry declined at least ${number(params, "value")} time(s) rather than repeating a call`,
    description:
      "A POST is not retried unless the adapter declares it replay-safe; this is the evidence.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.retriesDeclined,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  coordinatorRoundTripsAtMost: {
    name: "coordinatorRoundTripsAtMost",
    claim: (params) =>
      `at most ${number(params, "value")} coordinator round trip(s) per execution`,
    description:
      "What coordination costs - the number a reader weighs against the benefit.",
    evaluate: (summary, params) =>
      compare(
        summary.coordination?.roundTripsPerExecution,
        number(params, "value"),
        (a, e) => a <= e,
      ),
  },
  coordinatorErrorsEquals: {
    name: "coordinatorErrorsEquals",
    claim: (params) =>
      `the coordinator reported ${number(params, "value")} error(s)`,
    evaluate: (summary, params) =>
      compare(
        summary.coordination?.errors,
        number(params, "value"),
        (a, e) => a === e,
      ),
  },
  evalshaRatioAtLeast: {
    name: "evalshaRatioAtLeast",
    claim: (params) =>
      `at least ${Math.round(number(params, "value") * 100)}% of script calls were EVALSHA`,
    description:
      "Script bodies cross the wire once, not per call. A low ratio means the cache keeps missing.",
    evaluate: (summary, params) => {
      const coordination = summary.coordination
      if (!coordination)
        return { expected: ">= x", actual: MISSING, passed: false }
      const total = coordination.evalsha + coordination.eval
      if (total === 0)
        return {
          expected: "more than 0 script calls",
          actual: "0",
          passed: false,
        }
      const ratio = coordination.evalsha / total
      return {
        expected: `>= ${(number(params, "value") * 100).toFixed(0)}%`,
        actual: `${(ratio * 100).toFixed(1)}%`,
        passed: ratio >= number(params, "value"),
      }
    },
  },
  eventCountAtLeast: {
    name: "eventCountAtLeast",
    claim: (params) =>
      `the stream contained at least ${number(params, "value")} \`${text(params, "type")}\` event(s)`,
    description:
      "Proves a code path was exercised, rather than inferring it from behaviour.",
    evaluate: (summary, params) =>
      compare(
        summary.caracal.eventsByType[text(params, "type")] ?? 0,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  rejectionsByReasonAtLeast: {
    name: "rejectionsByReasonAtLeast",
    claim: (params) =>
      `at least ${number(params, "value")} rejection(s) with reason \`${text(params, "reason")}\``,
    evaluate: (summary, params) =>
      compare(
        summary.caracal.bulkheadRejectionsByReason[text(params, "reason")] ?? 0,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  witnessFailuresAtLeast: {
    name: "witnessFailuresAtLeast",
    claim: (params) =>
      `the dependency failed at least ${number(params, "value")} call(s)`,
    description:
      "The overload's signature: the dependency itself failed requests, not just shed them.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.failures,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  witnessAbandonedAtLeast: {
    name: "witnessAbandonedAtLeast",
    claim: (params) =>
      `the dependency saw at least ${number(params, "value")} response(s) the client abandoned`,
    description:
      "The dispose signature: a client cancelled a response body before it was written.",
    evaluate: (summary, params) =>
      compare(
        summary.witness?.abandoned,
        number(params, "value"),
        (a, e) => a >= e,
      ),
  },
  successRateAtMost: {
    name: "successRateAtMost",
    claim: (params) =>
      `at most ${Math.round(number(params, "value") * 100)}% of calls succeeded`,
    description:
      "The client's view of an overloaded dependency: failures reach the caller.",
    evaluate: (summary, params) => {
      const total = summary.client.requests
      if (total === 0)
        return { expected: "<= 100%", actual: MISSING, passed: false }
      const rate = summary.client.success / total
      return {
        expected: `<= ${Math.round(number(params, "value") * 100)}%`,
        actual: `${(rate * 100).toFixed(1)}%`,
        passed: rate <= number(params, "value"),
      }
    },
  },
}

export function checkNames(): string[] {
  return Object.keys(CHECKS)
}

/** Runs the specs a demo declared, failing loudly on an unknown name. */
export function runChecks(
  summary: Summary,
  specs: readonly CheckSpec[],
): CheckResult[] {
  const results: CheckResult[] = []
  for (const spec of specs) {
    const definition = CHECKS[spec.name]
    if (!definition) {
      throw new Error(
        `unknown check \`${spec.name}\`. Known checks: ${checkNames().join(", ")}`,
      )
    }
    const params = spec.params ?? {}
    const outcome = definition.evaluate(summary, params)
    const result: CheckResult = {
      name: definition.name,
      claim: definition.claim(params),
      expected: outcome.expected,
      actual: outcome.actual,
      passed: outcome.passed,
    }
    if (outcome.detail) result.detail = outcome.detail
    results.push(result)
  }
  return results
}
