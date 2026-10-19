#!/usr/bin/env node
/**
 * Policy decisions without a dependency.
 *
 * `createScriptedAdapter` (caracal 0.10.0) answers each `execute()` from a fixed
 * script and records the invocations the runtime made. That makes the decisions
 * a policy takes - retry or decline, settle or abort, dispose or retain -
 * assertable without a network, a container, or an unreliable downstream.
 *
 * The same shape is what the planned AWS studies use for the claims an emulator
 * cannot produce on demand: a response lost after the work was accepted, a
 * throttling burst, an abandoned response body.
 *
 *   npm run scripted
 */
import { TimeoutError, operation, retry, timeout } from "@gkoos/caracal"
import { createScriptedAdapter } from "@gkoos/caracal/testing"

const failures = []

function check(label, condition, detail = "") {
  console.log(
    `  ${condition ? "ok  " : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`,
  )
  if (!condition) failures.push(label)
}

function scenario(title) {
  console.log(`\n${title}`)
}

scenario("1. Retry settles from the second scripted outcome")
{
  const events = []
  const adapter = createScriptedAdapter({
    capabilities: { abort: "supported", replay: "safe" },
    classify: (outcome) =>
      outcome.status === "failure" ? "retryable" : "success",
    outcomes: [
      { status: "failure", error: new Error("transient") },
      { status: "success", value: "ok" },
    ],
  })
  const subject = operation({
    name: "scripted-retry",
    adapter,
    policies: [retry({ maxAttempts: 2 })],
    events: { emit: (event) => events.push(event) },
  })

  const result = await subject.execute(undefined)
  const attempts = adapter.calls.map((call) => call.context.attempt).join(",")
  check("the second outcome is returned", result === "ok", String(result))
  check("both attempts were recorded, in order", attempts === "1,2", attempts)
  check(
    "retry.scheduled fired exactly once",
    events.filter((event) => event.type === "retry.scheduled").length === 1,
  )
}

scenario("2. A replay-unsafe command is not retried")
{
  const events = []
  const adapter = createScriptedAdapter({
    capabilities: { abort: "supported", replay: "unsafe" },
    classify: (outcome) =>
      outcome.status === "failure" ? "retryable" : "success",
    outcomes: [
      { status: "failure", error: new Error("the response was lost") },
      { status: "success", value: "would be a duplicate" },
    ],
  })
  const subject = operation({
    name: "scripted-unsafe",
    adapter,
    policies: [retry({ maxAttempts: 3 })],
    events: { emit: (event) => events.push(event) },
  })

  await subject.execute(undefined).catch(() => {})
  const declined = events.find((event) => event.type === "retry.declined")
  check(
    "the second outcome is never consumed",
    adapter.calls.length === 1,
    `${adapter.calls.length} call(s)`,
  )
  check(
    "retry.declined reports replay-unsafe",
    declined?.reason === "replay-unsafe",
    declined?.reason ?? "no event",
  )
}

scenario("3. An abandoned outcome is disposed")
{
  const disposed = []
  const adapter = createScriptedAdapter({
    capabilities: { abort: "supported", replay: "safe" },
    classify: (outcome) =>
      outcome.status === "failure" ? "retryable" : "success",
    outcomes: [
      { status: "failure", error: new Error("transient") },
      { status: "success", value: "ok" },
    ],
    dispose: (outcome) => disposed.push(outcome.status),
  })
  const subject = operation({
    name: "scripted-dispose",
    adapter,
    policies: [retry({ maxAttempts: 2 })],
  })

  const result = await subject.execute(undefined)
  check("the retry returns the second outcome", result === "ok", String(result))
  check(
    "dispose saw the abandoned first outcome exactly once",
    disposed.join(",") === "failure",
    disposed.join(",") || "not called",
  )
}

scenario("4. A hanging outcome is bounded by timeout")
{
  const adapter = createScriptedAdapter({
    capabilities: { abort: "supported", replay: "safe" },
    outcomes: [{ status: "hang" }],
  })
  const subject = operation({
    name: "scripted-timeout",
    adapter,
    policies: [timeout({ ms: 25 })],
  })

  let error
  try {
    await subject.execute(undefined)
  } catch (caught) {
    error = caught
  }
  check(
    "the caller receives TimeoutError",
    error instanceof TimeoutError,
    error?.constructor?.name ?? "resolved",
  )
  check(
    "the hang was reserved exactly once",
    adapter.calls.length === 1,
    `${adapter.calls.length} call(s)`,
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} scripted check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  "\nscripted adapter verified: no dependency, no container, no network.",
)
