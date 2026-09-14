#!/usr/bin/env node
/**
 * M0 acceptance check: proves the whole chain works before any demo exists.
 *
 *   caracal pipeline -> event sink -> OTLP -> collector -> Prometheus + Jaeger
 *
 * It runs a real policy pipeline (breaker, timeout, retry, bulkhead) against a
 * synthetic adapter, in either coordination, writes a `summary.json` and a
 * `report.md`, and - when the stack is up - asserts that the execution is
 * queryable in Prometheus and that its trace reached Jaeger.
 *
 *   npm run smoke                          # healthy dependency, local policies
 *   npm run smoke:distributed              # same workload, one shared budget
 *   npm run smoke:breaker                  # watch the breaker open instead
 *   CARACAL_OTEL=off npm run smoke         # no SDK, no stack queries
 *
 * With `npm run`, options must be inside the script (see package.json) or passed
 * as environment variables - npm consumes `--flag` and `--flag=value` as its own
 * configuration before the script ever sees them.
 */
import { mkdirSync } from "node:fs"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import {
  BulkheadRejectedError,
  CircuitOpenError,
  TimeoutError,
  operation,
} from "@gkoos/caracal"
import { CoordinatorUnavailableError } from "@gkoos/caracal/redis"
import {
  buildPolicies,
  createCoordinators,
  describeConfig,
  loadConfig,
  syntheticAdapter,
} from "partner-api"
import { ndjsonSink, startObservability } from "caracal-observability"
import {
  EventSummarizer,
  createSummary,
  finalizeSummary,
  latency,
  writeReport,
  writeSummary,
} from "caracal-runner"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const CARACAL_VERSION = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@gkoos/caracal/package.json"),
    "utf8",
  ),
).version

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1) {
    const next = process.argv[index + 1]
    return next && !next.startsWith("--") ? next : true
  }
  // npm consumes a bare `--flag value` pair for its own configuration before the
  // script sees it, so environment variables are the reliable input and an
  // argument is the direct-invocation convenience.
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return fallback
}

const topology = String(arg("topology", process.env.TOPOLOGY ?? "local"))
const requests = Number(arg("requests", process.env.REQUESTS ?? 400))
const concurrency = Number(arg("concurrency", process.env.CONCURRENCY ?? 16))
const failureRate = Number(arg("failure-rate", process.env.FAILURE_RATE ?? 0))
const retryAttempts = Number(
  arg("retry-attempts", process.env.RETRY_MAX_ATTEMPTS ?? 2),
)
// The demo label identifies the *scenario*, not just the topology: `compare`
// resolves a selector to that scenario's latest run, so two variants of the same
// topology must not share a name or they overwrite each other's column.
const variant = failureRate > 0 ? "-breaker" : ""
const demo = `smoke-${topology}${variant}`
const otelSetting = String(
  arg("otel", process.env.CARACAL_OTEL ?? "on"),
).toLowerCase()
const withOtel =
  otelSetting !== "off" && otelSetting !== "false" && otelSetting !== "0"
const runId = `${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}_${demo}`
const runDirectory = `${ROOT}runs/${runId}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Queries Prometheus until `predicate` holds, or gives up. */
async function prometheus(expression, deadlineMs = 20_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expression)}`,
      )
      const body = await response.json()
      last = body
      if (body?.data?.result?.length > 0) return body
    } catch {
      /* stack may still be starting */
    }
    await sleep(1_000)
  }
  return last
}

/** Looks for any trace of our service in Jaeger. */
async function jaeger(service, deadlineMs = 20_000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:16686/api/traces?service=${encodeURIComponent(service)}&limit=5`,
      )
      const body = await response.json()
      last = body
      if (body?.data?.length > 0) return body
    } catch {
      /* stack may still be starting */
    }
    await sleep(1_000)
  }
  return last
}

/** The caller-visible classification of a failed call. */
function classify(error) {
  if (error instanceof TimeoutError) return { bucket: "timedOut" }
  if (error instanceof CircuitOpenError) return { refused: "breaker-open" }
  if (error instanceof BulkheadRejectedError)
    return { refused: `bulkhead:${error.reason}` }
  if (error instanceof CoordinatorUnavailableError)
    return { refused: "coordinator-unavailable" }
  return { bucket: "failure" }
}

const config = loadConfig({
  ...process.env,
  DEMO: demo,
  RUN_ID: runId,
  REPLICA: "0",
  TOPOLOGY: topology,
  SCOPE: process.env.SCOPE ?? "global",
  CARACAL_NAMESPACE: `caracal-demo:${runId}`,
  BULKHEAD_LIMIT: process.env.BULKHEAD_LIMIT ?? String(concurrency),
  RETRY_MAX_ATTEMPTS: String(retryAttempts),
  BREAKER_MINIMUM_THROUGHPUT: process.env.BREAKER_MINIMUM_THROUGHPUT ?? "10",
  BREAKER_OPEN_MS: process.env.BREAKER_OPEN_MS ?? "1000",
})

mkdirSync(runDirectory, { recursive: true })

const coordinators = createCoordinators(config, config.namespace)
if (config.topology === "distributed") {
  try {
    await coordinators.connect()
  } catch (error) {
    console.error(
      `cannot reach the coordinator at ${config.redis.url}: ${error.message}\n` +
        "Start the stack first: npm run stack:up",
    )
    process.exit(1)
  }
}

const observability = await startObservability({
  serviceName: "caracal-demo-smoke",
  enabled: withOtel,
  baseLabels: { demo, run_id: runId },
  resourceAttributes: { replica: config.replica },
})

const events = ndjsonSink({ path: `${runDirectory}/events.ndjson` })
const summarizer = new EventSummarizer()
const policies = buildPolicies(config, coordinators)

const subject = operation({
  name: "smoke-op",
  adapter: syntheticAdapter(),
  policies: policies.policies,
  events: [
    { emit: (event) => summarizer.record(event) },
    observability.telemetry.sink(),
    events,
  ],
})

const latencies = []
const refusedByReason = {}
let success = 0
let failure = 0
let timedOut = 0
let issued = 0
const startedAt = Date.now()

async function worker() {
  while (issued < requests) {
    issued += 1
    const at = performance.now()
    try {
      await subject.execute({
        workloadMs: 20 + Math.floor(Math.random() * 40),
        fail: Math.random() < failureRate,
      })
      success += 1
    } catch (error) {
      const classified = classify(error)
      if (classified.timedOut) timedOut += 1
      else if (classified.refused) {
        refusedByReason[classified.refused] =
          (refusedByReason[classified.refused] ?? 0) + 1
      } else failure += 1
    } finally {
      latencies.push(performance.now() - at)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker))
const durationMs = Date.now() - startedAt

const openTraces = observability.telemetry.traces.trackedExecutions()
await observability.shutdown()
await events.close()
coordinators.disconnect()

const checks = [
  { name: "requestsAtLeast", params: { value: Math.floor(requests * 0.95) } },
  {
    name: "eventCountAtLeast",
    params: { type: "execution.settled", value: requests },
  },
]
if (failureRate === 0) {
  // A healthy dependency is the case where every claim must hold exactly.
  checks.push({
    name: "eventCountAtLeast",
    params: { type: "attempt.started", value: requests },
  })
  checks.push({ name: "successRateAtLeast", params: { value: 0.99 } })
  checks.push({ name: "refusedAtMost", params: { value: 0 } })
} else {
  // With failures injected, the breaker has to shed traffic - otherwise this
  // smoke is not exercising the rejection path at all. Note the arithmetic this
  // depends on: the breaker sits outside retry, so it sees one outcome per
  // execution, and `npm run smoke:breaker` therefore disables retry. With retry
  // on, a 60% per-attempt failure rate becomes a ~36% execution-level one and a
  // 50% threshold never fires.
  checks.push({
    name: "eventCountAtLeast",
    params: { type: "breaker.rejected", value: 1 },
  })
  checks.push({
    name: "eventCountAtLeast",
    params: { type: "breaker.state-changed", value: 1 },
  })
}
if (config.topology === "distributed") {
  checks.push({ name: "evalshaRatioAtLeast", params: { value: 0.8 } })
  checks.push({ name: "coordinatorRoundTripsAtMost", params: { value: 8 } })
}

const summary = createSummary({
  demo,
  title: `smoke (${config.topology} coordination)`,
  caracalVersion: CARACAL_VERSION,
  caracalSource: "npm",
  topology: {
    policies: config.topology,
    scope: config.scope,
    config: describeConfig(config),
  },
  workload: {
    durationMs,
    concurrency,
    replicas: 1,
    byOperation: { "smoke-op": issued },
  },
  client: {
    requests: issued,
    success,
    failure,
    refusedByReason,
    timedOut,
    latencyMs: latency(latencies),
    rps: Math.round((issued / Math.max(1, durationMs)) * 1000),
  },
  caracal: summarizer.snapshot(),
  coordination: {
    commands: coordinators.stats.commands,
    evalsha: coordinators.stats.evalsha,
    eval: coordinators.stats.eval,
    errors: coordinators.stats.errors,
    roundTripsPerExecution: Number(
      (coordinators.stats.commands / Math.max(1, issued)).toFixed(2),
    ),
  },
  notes: [
    `traces-open:${openTraces}`,
    config.topology === "distributed"
      ? `${coordinators.stats.commands} coordinator commands for ${issued} executions`
      : "no coordinator was involved in this run",
  ],
})
finalizeSummary(summary, checks)

const summaryPath = writeSummary(runDirectory, summary)
writeReport(runDirectory, summary)

console.log(
  `\nsmoke: ${config.topology} topology, ${issued} executions in ${durationMs}ms`,
)
console.log(
  `  caller:    ${success} ok, ${failure} failed, ${timedOut} timed out, ` +
    `refused ${JSON.stringify(refusedByReason)}`,
)
console.log(
  `  caracal:   ${JSON.stringify(summary.caracal.executionsByOutcome)} executions, ` +
    `${JSON.stringify(summary.caracal.attemptsByClassification)} attempts`,
)
if (config.topology === "distributed") {
  console.log(
    `  redis:     ${coordinators.stats.commands} commands ` +
      `(evalsha ${coordinators.stats.evalsha}, eval ${coordinators.stats.eval}), ` +
      `${summary.coordination.roundTripsPerExecution} per execution`,
  )
}
console.log(`  artifacts: ${summaryPath}`)
console.log(`  traces still open at exit: ${openTraces}`)

let ok = true
for (const check of summary.checks) {
  console.log(
    `  ${check.passed ? "ok  " : "FAIL"}  ${check.claim} (${check.actual})`,
  )
  if (!check.passed) ok = false
}

if (withOtel) {
  const metric = await prometheus(
    `sum(caracal_executions_total{demo="${demo}"})`,
  )
  const observed = metric?.data?.result?.[0]?.value?.[1]
  const traces = await jaeger("caracal-demo-smoke")
  const spans =
    traces?.data?.reduce((total, trace) => total + trace.spans.length, 0) ?? 0
  if (observed === undefined) {
    console.log(
      "  FAIL  caracal_executions_total is not in Prometheus (is the stack up?)",
    )
    ok = false
  } else {
    console.log(
      `  ok    Prometheus reports ${observed} executions for demo="${demo}"`,
    )
  }
  if (spans === 0) {
    console.log(
      "  FAIL  no trace reached Jaeger for service caracal-demo-smoke",
    )
    ok = false
  } else {
    console.log(
      `  ok    Jaeger has ${traces.data.length} trace(s), ${spans} spans`,
    )
    const sample = traces.data[0]
    const attempts = sample.spans.filter(
      (span) => span.operationName === "caracal.attempt",
    ).length
    const decisions = sample.spans.reduce(
      (total, span) => total + (span.logs?.length ?? 0),
      0,
    )
    console.log(
      `        ${sample.traceID}: ${sample.spans.length} span(s), ` +
        `${attempts} attempt span(s), ${decisions} policy decision(s) as span events`,
    )
  }
} else {
  console.log(
    "  --    OTLP export disabled (--otel off); stack queries skipped",
  )
}

console.log(`\n${ok ? "smoke passed" : "smoke FAILED"}`)
process.exit(ok ? 0 : 1)
