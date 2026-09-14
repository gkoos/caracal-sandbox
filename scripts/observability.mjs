#!/usr/bin/env node
/**
 * 06 - Observability and cost: the sink contract, made measurable.
 *
 * Three claims, each demonstrated and asserted:
 *
 * 1. One execution = one trace, with an attempt span per retry and every policy
 *    decision as a span event (queryable in Jaeger).
 * 2. The sink is fire-and-forget: a throwing sink and a slow *async* sink do not
 *    move p99, while a synchronously blocking sink does - and that is the only
 *    kind that can.
 * 3. Events carry `{status}` only: no response body or error message reaches a
 *    sink.
 *
 *   npm run observability
 *   CARACAL_OTEL=off npm run observability   # skip the Jaeger part
 */
import { operation, retry } from "@gkoos/caracal"
import {
  asyncSlowSink,
  blockingSink,
  failingSink,
  startObservability,
} from "caracal-observability"

const requests = Number(process.env.REQUESTS ?? 600)
const otelEnabled = (process.env.CARACAL_OTEL ?? "on").toLowerCase() !== "off"
const failures = []

function check(label, ok, detail = "") {
  if (ok) console.log(`  ok    ${label}`)
  else {
    failures.push(`${label}${detail ? ` - ${detail}` : ""}`)
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`)
  }
}

function p99(sorted) {
  return sorted[Math.floor(sorted.length * 0.99)] ?? 0
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function jaegerTraces(service, deadlineMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:16686/api/traces?service=${encodeURIComponent(service)}&limit=50`,
      )
      const body = await response.json()
      if (body?.data?.length > 0) return body.data
    } catch {
      /* stack may still be starting */
    }
    await sleep(1_000)
  }
  return []
}

// ---------------------------------------------------------------------------
// Part 3 first (it is pure and fast): payload redaction.
// ---------------------------------------------------------------------------

const captured = []
const failing = operation({
  name: "redaction-op",
  adapter: {
    capabilities: () => ({ abort: "supported", replay: "safe" }),
    execute: async () => {
      throw new Error("secret internal detail that must not leak")
    },
    classify: () => "failure",
  },
  policies: [retry({ maxAttempts: 1 })],
  events: { emit: (event) => captured.push(event) },
})
await failing.execute(undefined).catch(() => {})

const settled = captured.find((event) => event.type === "execution.settled")
const outcomeKeys = settled ? Object.keys(settled.outcome).sort() : []
check(
  "events carry {status} only - no value, no error object",
  outcomeKeys.length === 1 && outcomeKeys[0] === "status",
  `keys: [${outcomeKeys.join(", ")}]`,
)
const hasSecret = JSON.stringify(captured).includes("secret internal detail")
check("the error message never reached the sink", !hasSecret)

// ---------------------------------------------------------------------------
// Part 1: one execution = one trace, with an attempt span per retry.
// ---------------------------------------------------------------------------

const observability = await startObservability({
  serviceName: "caracal-observability-demo",
  enabled: otelEnabled,
})

const flaky = operation({
  name: "flaky-op",
  adapter: {
    capabilities: () => ({ abort: "supported", replay: "safe" }),
    execute: async (_args, context) => {
      await sleep(2)
      if (context.attempt === 1) throw new Error("transient")
      return "ok"
    },
    classify: (outcome) =>
      outcome.status === "success" ? "success" : "retryable",
  },
  policies: [retry({ maxAttempts: 2, delay: 2 })],
  events: [observability.telemetry.sink()],
})

// Every execution fails its first attempt and recovers on the second: a retried
// execution is exactly the trace shape we want to prove.
for (let index = 0; index < 20; index += 1) await flaky.execute(undefined)
await observability.shutdown()

if (otelEnabled) {
  const traces = await jaegerTraces("caracal-observability-demo")
  const withRetry = traces.find(
    (trace) =>
      trace.spans.filter((span) => span.operationName === "caracal.attempt")
        .length >= 2,
  )
  const decisions = traces.reduce(
    (total, trace) =>
      total +
      trace.spans.reduce((sum, span) => sum + (span.logs?.length ?? 0), 0),
    0,
  )
  check("traces reached Jaeger", traces.length > 0, `traces: ${traces.length}`)
  check(
    "a retried execution has 2 attempt spans in one trace",
    Boolean(withRetry),
    withRetry
      ? `trace ${withRetry.traceID}`
      : "no trace with >= 2 attempt spans",
  )
  check(
    "policy decisions are span events on the execution",
    decisions >= 20,
    `span events across traces: ${decisions}`,
  )
} else {
  console.log("  --    OTel disabled (CARACAL_OTEL=off); trace shape skipped")
}

// ---------------------------------------------------------------------------
// Part 2: the sink is fire-and-forget.
// ---------------------------------------------------------------------------

const quickAdapter = {
  capabilities: () => ({ abort: "supported", replay: "safe" }),
  execute: async () => {
    await sleep(5)
    return "ok"
  },
  classify: (outcome) => (outcome.status === "success" ? "success" : "failure"),
}

async function measureLatency(sinks) {
  const op = operation({
    name: "sink-probe",
    adapter: quickAdapter,
    events: sinks.length > 0 ? sinks : undefined,
  })
  const times = []
  for (let index = 0; index < requests; index += 1) {
    const at = performance.now()
    await op.execute(undefined)
    times.push(performance.now() - at)
  }
  times.sort((a, b) => a - b)
  return p99(times)
}

const baseline = await measureLatency([])
const throwing = await measureLatency([failingSink()])
const asyncSlow = await measureLatency([asyncSlowSink(200)])
const blocking = await measureLatency([blockingSink(8)])

console.log(`\n  p99 latency (${requests} executions, ~5ms adapter):`)
console.log(`    baseline (no sink)       ${baseline.toFixed(1)}ms`)
console.log(`    throwing sink            ${throwing.toFixed(1)}ms`)
console.log(`    slow async sink (200ms)  ${asyncSlow.toFixed(1)}ms`)
console.log(`    blocking sink (8ms)      ${blocking.toFixed(1)}ms`)

const tolerance = Math.max(3, baseline * 0.6)
check(
  "a throwing sink does not move p99",
  throwing <= baseline + tolerance,
  `${baseline.toFixed(1)} -> ${throwing.toFixed(1)}ms`,
)
check(
  "a slow async sink does not move p99",
  asyncSlow <= baseline + tolerance,
  `${baseline.toFixed(1)} -> ${asyncSlow.toFixed(1)}ms`,
)
check(
  "a synchronously blocking sink is the only kind that can",
  blocking >= baseline + 4,
  `${baseline.toFixed(1)} -> ${blocking.toFixed(1)}ms`,
)

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log()
if (failures.length > 0) {
  console.log(`observability FAILED (${failures.length}):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log("observability: all claims hold")
