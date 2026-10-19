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
const awsSdkModule = await import("@gkoos/caracal/aws-sdk")

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
  rateLimit: "object",
  TimeoutError: "function",
  CircuitOpenError: "function",
  BulkheadRejectedError: "function",
  RateLimitExceededError: "function",
})

checkExports("bulkhead", caracal.bulkhead, {
  local: "function",
  distributed: "function",
})

checkExports("circuitBreaker", caracal.circuitBreaker, {
  local: "function",
  distributed: "function",
})

checkExports("rateLimit", caracal.rateLimit, {
  local: "function",
  distributed: "function",
})

checkExports("@gkoos/caracal/redis", redisModule, {
  createCoordinationClient: "function",
  createCoordinationClusterClient: "function",
  redisCoordinator: "function",
  redisCircuitBreakerCoordinator: "function",
  redisRateLimitCoordinator: "function",
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
  createScriptedAdapter: "function",
})

checkExports("@gkoos/caracal/aws-sdk", awsSdkModule, {
  awsSdkAdapter: "function",
  awsSdkErrorClassification: "function",
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

// The scripted adapter is the sandbox's dependency-free instrument: it answers
// from a fixed script and records what the runtime asked for, so a policy
// decision can be asserted exactly. It is also the shape the planned AWS replay
// study uses, where the failure is a response lost after the work was accepted.
const scriptedEvents = []
const scripted = testingModule.createScriptedAdapter({
  capabilities: { abort: "supported", replay: "safe" },
  classify: (outcome) =>
    outcome.status === "failure" ? "retryable" : "success",
  outcomes: [
    { status: "failure", error: new Error("transient") },
    { status: "success", value: "ok" },
  ],
})
const scriptedRun = caracal.operation({
  name: "verify-scripted",
  adapter: scripted,
  policies: [caracal.retry({ maxAttempts: 2 })],
  events: { emit: (event) => scriptedEvents.push(event) },
})
check(
  "scripted adapter settles a retry",
  (await scriptedRun.execute(undefined)) === "ok",
)
check(
  "scripted adapter recorded the attempts in order",
  scripted.calls.map((call) => call.context.attempt).join(",") === "1,2",
  scripted.calls.map((call) => call.context.attempt).join(","),
)
check(
  "scripted adapter emitted the retry lifecycle",
  scriptedEvents.filter((event) => event.type === "retry.scheduled").length ===
    1,
)

const unsafeEvents = []
const unsafe = testingModule.createScriptedAdapter({
  capabilities: { abort: "supported", replay: "unsafe" },
  classify: (outcome) =>
    outcome.status === "failure" ? "retryable" : "success",
  outcomes: [
    { status: "failure", error: new Error("already applied") },
    { status: "success", value: "duplicate" },
  ],
})
const unsafeRun = caracal.operation({
  name: "verify-scripted-unsafe",
  adapter: unsafe,
  policies: [caracal.retry({ maxAttempts: 3 })],
  events: { emit: (event) => unsafeEvents.push(event) },
})
await unsafeRun.execute(undefined).catch(() => {})
check(
  "scripted adapter proves replay-unsafe declines a retry",
  unsafe.calls.length === 1 &&
    unsafeEvents.some(
      (event) =>
        event.type === "retry.declined" && event.reason === "replay-unsafe",
    ),
  `${unsafe.calls.length} call(s), ${unsafeEvents.map((event) => event.type).join(",")}`,
)

class GetItemCommand {}
class SendMessageCommand {}
const awsRead = awsSdkModule.awsSdkAdapter({
  client: { send: async () => "ok" },
  command: () => new GetItemCommand(),
})
check(
  "aws adapter declares abort support",
  awsRead.capabilities({}).abort === "supported",
)
check(
  "aws adapter derives safe replay for GetItem",
  awsRead.capabilities({}).replay === "safe",
)
const awsSend = awsSdkModule.awsSdkAdapter({
  client: { send: async () => "ok" },
  command: () => new SendMessageCommand(),
})
check(
  "aws adapter marks SendMessage unsafe",
  awsSend.capabilities({}).replay === "unsafe",
)

if (failures.length > 0) {
  console.error(`\n${failures.length} surface check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("\ncaracal surface verified.")
