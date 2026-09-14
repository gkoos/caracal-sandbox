#!/usr/bin/env node
/**
 * Asserts the installed @gkoos/caracal surface is the one this demo suite is
 * written against, and that the runtime pieces actually build a working
 * pipeline.
 *
 * The demos are written against a published package, not against a checkout, so
 * a version bump that renames a factory or drops a type must fail here rather
 * than somewhere inside a demo.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const ROOT = new URL("../package.json", import.meta.url)
const pinned = JSON.parse(readFileSync(ROOT, "utf8")).dependencies[
  "@gkoos/caracal"
]
const installed = JSON.parse(
  readFileSync(require.resolve("@gkoos/caracal/package.json"), "utf8"),
)

const failures = []

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`)
    return
  }
  failures.push(`${label}${detail ? ` - ${detail}` : ""}`)
  console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`)
}

function checkExports(label, module, expected) {
  for (const [name, kind] of Object.entries(expected)) {
    const value = module[name]
    const actual = typeof value
    check(
      `${label} exports ${name} (${kind})`,
      actual === kind,
      `expected ${kind}, got ${actual}`,
    )
  }
}

const caracal = await import("@gkoos/caracal")
const redisModule = await import("@gkoos/caracal/redis")
const fetchModule = await import("@gkoos/caracal/fetch")
const postgresModule = await import("@gkoos/caracal/postgres")
const testingModule = await import("@gkoos/caracal/testing")

console.log(`@gkoos/caracal@${installed.version} (pinned: ${pinned})`)
check(
  "installed version matches the pinned version",
  installed.version === pinned,
)

checkExports("@gkoos/caracal", caracal, {
  operation: "function",
  timeout: "function",
  retry: "function",
  bulkhead: "object",
  circuitBreaker: "object",
  TimeoutError: "function",
  CircuitOpenError: "function",
  BulkheadRejectedError: "function",
})

checkExports("bulkhead", caracal.bulkhead, {
  local: "function",
  distributed: "function",
})

checkExports("circuitBreaker", caracal.circuitBreaker, {
  local: "function",
  distributed: "function",
})

checkExports("@gkoos/caracal/redis", redisModule, {
  createCoordinationClient: "function",
  createCoordinationClusterClient: "function",
  redisCoordinator: "function",
  redisCircuitBreakerCoordinator: "function",
  CoordinatorUnavailableError: "function",
})

checkExports("@gkoos/caracal/fetch", fetchModule, {
  fetchAdapter: "function",
  createRetryAfterDelay: "function",
  retryAfterDelay: "function",
  retryAfterMs: "function",
})

checkExports("@gkoos/caracal/postgres", postgresModule, {
  postgresAdapter: "function",
})

checkExports("@gkoos/caracal/testing", testingModule, {
  defineAdapterContractSuite: "function",
  runAdapterContractSuite: "function",
})

// Existing is not the same as working: build one pipeline of each coordination
// and drive a call through it.
const events = []
const breaker = caracal.circuitBreaker.local({
  name: "verify-local-breaker",
  minimumThroughput: 2,
  failureThreshold: 0.5,
  openMs: 1_000,
})
const capacity = caracal.bulkhead.local({
  name: "verify-local-bulkhead",
  limit: 2,
})

const local = caracal.operation({
  name: "verify-local",
  adapter: {
    capabilities: () => ({ abort: "supported", replay: "safe" }),
    execute: async () => "ok",
  },
  policies: [
    breaker,
    caracal.timeout({ ms: 1_000 }),
    caracal.retry({ maxAttempts: 2 }),
    capacity,
  ],
  events: { emit: (event) => events.push(event) },
})

const result = await local.execute(undefined)
check("local pipeline executes", result === "ok")
check(
  "local pipeline emits the lifecycle",
  [
    "execution.started",
    "attempt.started",
    "attempt.settled",
    "execution.settled",
  ].every((type) => events.some((event) => event.type === type)),
  `saw ${[...new Set(events.map((event) => event.type))].join(", ")}`,
)
check(
  "bulkhead.snapshot() reports occupancy for local policies",
  typeof capacity.snapshot === "function" &&
    capacity.snapshot().coordination === "local",
)
check(
  "policy objects carry their coordination",
  breaker.coordination === "local" && capacity.coordination === "local",
)

if (failures.length > 0) {
  console.error(`\n${failures.length} surface check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("\ncaracal surface verified.")
