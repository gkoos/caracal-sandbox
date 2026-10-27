#!/usr/bin/env node
/**
 * The demo orchestrator.
 *
 * A demo is a manifest (`study.yaml`) plus this runner. It owns the whole
 * lifecycle: start the dependency (the witness), start the partner-api replicas,
 * drive load, then stop everything and write one `summary.json` + `report.md`.
 *
 *   npm run demo 01                 # run case-studies/01-local-only
 *   npm run demo 01 -- --live       # leave the processes running for inspection
 *   npm run demo 01 -- --duration=5000   # shorten the scenario
 *
 * The claim in a demo is decided on two independent numbers - what the replicas
 * reported through events, and what the dependency measured about itself - which
 * is why the summary has a `caracal` block and a `witness` block that never feed
 * into one another.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Redis } from "ioredis"
import { parse as parseYaml } from "yaml"
import { resetWitness, runLoad } from "loadgen"
import {
  EventSummarizer,
  checkNames,
  createSummary,
  finalizeSummary,
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
// `link:local` rewrites the dependency to a tarball, so the spec is the difference
// between a run that measured the published package and one that measured a
// checkout. Recorded with every artifact: a number without its provenance is a claim.
const CARACAL_SOURCE = JSON.parse(
  readFileSync(`${ROOT}package.json`, "utf8"),
).dependencies["@gkoos/caracal"].startsWith("file:")
  ? "local"
  : "npm"

const DEMO_ID = process.argv[2]
// `npm run` consumes `--flag=value` before the script sees it, so every switch
// also reads an environment variable; the flags exist for direct `node` runs.
const LIVE = process.argv.includes("--live") || process.env.DEMO_LIVE === "1"
const DURATION_OVERRIDE = Number(
  process.argv.find((arg) => arg.startsWith("--duration="))?.slice(11) ??
    process.env.DEMO_DURATION_MS ??
    0,
)
const PORT_BASE = Number(
  process.argv.find((arg) => arg.startsWith("--port-base="))?.slice(12) ??
    process.env.DEMO_PORT_BASE ??
    4101,
)
const DOWNSTREAM_PORT = Number(process.env.DOWNSTREAM_PORT ?? 4200)

if (!DEMO_ID) {
  console.error("usage: npm run demo <id> [--live] [--duration=ms]")
  process.exit(2)
}

// Match `npm run demo 01` and `npm run demo 01-local-only` alike: the selector
// is compared against each manifest's `id`, not against the folder name.
const demoPath = readdirSync(`${ROOT}case-studies`)
  .map((entry) => `${ROOT}case-studies/${entry}/study.yaml`)
  .find((path) => {
    if (!existsSync(path)) return false
    const candidate = parseYaml(readFileSync(path, "utf8"))
    return candidate.id === DEMO_ID || candidate.id.startsWith(`${DEMO_ID}-`)
  })

const demoDir = demoPath?.replace(/\/study\.yaml$/, "")
if (!demoDir) {
  console.error(`no demo found for \`${DEMO_ID}\` under ${ROOT}case-studies`)
  process.exit(1)
}

const demo = parseYaml(readFileSync(`${demoDir}/study.yaml`, "utf8"))
const durationMs = DURATION_OVERRIDE || demo.scenario.durationMs

// Validate the checks before starting anything: a typo should not cost a run.
for (const check of demo.checks ?? []) {
  if (!checkNames().includes(check.name)) {
    console.error(`unknown check \`${check.name}\` in ${demoDir}/study.yaml`)
    console.error(`known checks: ${checkNames().join(", ")}`)
    process.exit(1)
  }
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}_${demo.id}`
const runDirectory = `${ROOT}runs/${runId}`
mkdirSync(runDirectory, { recursive: true })

const children = []

function spawnProcess(name, entry, env, shutdownUrl) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  })
  child.on("exit", (code, signal) => {
    // Killed by a signal is the normal shutdown path (see stopAll). A crash
    // exits on its own with a non-zero code and no signal, which is what warns.
    if (signal === null && code !== null && code !== 0 && !LIVE) {
      console.error(`${name} exited early (code ${code})`)
    }
  })
  children.push({ name, child, shutdownUrl })
  return child
}

async function waitHealthy(url, name, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(
    `${name} at ${url} did not become healthy within ${timeoutMs}ms`,
  )
}

function stopAll() {
  return Promise.all(
    children.map(async ({ name, child, shutdownUrl }) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        // Graceful, cross-platform: a POSIX signal would not run the child's
        // handler on Windows, so each process owns a shutdown endpoint instead.
        await fetch(`${shutdownUrl}/_admin/shutdown`, { method: "POST" })
      } catch {
        /* already gone, or no admin endpoint */
      }
      const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
      if (!exited) {
        console.error(`${name} did not shut down gracefully; killing`)
        child.kill("SIGKILL")
      }
    }),
  )
}

// Safety net: however this process exits, do not leave replica or dependency
// processes behind on the developer's machine.
process.on("exit", () => {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Timeline: named actions fired at offsets from the start of the load.
// ---------------------------------------------------------------------------

/** Chaos bookkeeping, shared by the timeline executor and the sampler. */
let chaosClient = null
const chaosActions = []
const leaseSamples = []
let maxLiveLeases = 0

/** Counts live (non-expired) bulkhead leases, on the coordinator's own clock. */
async function sampleLiveLeases(client) {
  const keys = await client.keys("caracal:v1:*:leases")
  let total = 0
  for (const key of keys) {
    const count = await client.eval(
      "local t=redis.call('TIME') local now=t[1]*1000+math.floor(t[2]/1000) return redis.call('ZCOUNT', KEYS[1], now+1, '+inf')",
      1,
      key,
    )
    total += Number(count)
  }
  return total
}

/** The dependency's own in-flight timeline; empty when it cannot be read. */
async function readTimeline(url) {
  try {
    const response = await fetch(`${url}/_witness/timeline`)
    return (await response.json()).samples ?? []
  } catch {
    return []
  }
}

async function applyAction(downstreamUrl, action) {
  if (action.action === "dependency.failRegions") {
    await fetch(`${downstreamUrl}/_control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failRegions: action.regions ?? [] }),
    })
    return
  }
  if (
    action.action === "dependency.fail" ||
    action.action === "dependency.recover"
  ) {
    // The timeline drives the dependency's failure rate: a failure window opens
    // the breaker, a healthy window lets a half-open probe close it.
    const failureRate = action.action === "dependency.fail" ? 1 : 0
    await fetch(`${downstreamUrl}/_control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failureRate }),
    })
    chaosActions.push(`${action.action}(failureRate=${failureRate})`)
    return
  }
  if (action.action === "replica.freeze") {
    // A spin-block past the lease: renewals and releases cannot fire while the
    // event loop is frozen, so the lease expires out from under the worker.
    const port = PORT_BASE + Number(action.replica ?? 0)
    chaosActions.push(`freeze:replica-${action.replica}(${action.ms}ms)`)
    await fetch(
      `http://127.0.0.1:${port}/_admin/freeze?ms=${action.ms ?? 1000}`,
      {
        method: "POST",
      },
    )
    return
  }
  if (action.action === "replica.kill") {
    // Abrupt death, no cleanup: the in-flight lease must expire on its own.
    // Look up by name - the `children` array also holds the downstream-mock.
    const entry = children.find(
      (child) => child.name === `replica-${action.replica}`,
    )
    if (entry) {
      chaosActions.push(`kill:replica-${action.replica}`)
      entry.child.kill("SIGKILL")
    }
    return
  }
  if (action.action === "redis.cut" || action.action === "redis.restore") {
    // The coordinator client is disconnected on every replica, and the client has no
    // offline queue, so every coordinator call fails until it is restored. Redis
    // itself stays up: this is the outage, not the data-loss case that
    // `redis.state-loss` produces.
    const path =
      action.action === "redis.cut" ? "coordinator-cut" : "coordinator-restore"
    chaosActions.push(`${action.action}(all ${replicas} replicas)`)
    await Promise.all(
      Array.from({ length: replicas }, (_, index) =>
        fetch(`http://127.0.0.1:${PORT_BASE + index}/_admin/${path}`, {
          method: "POST",
        }),
      ),
    )
    return
  }
  if (action.action === "redis.state-loss") {
    // Delete this run's coordination keys out from under it; the next observation
    // mints a fresh generation (see findings.md, finding 10's cousin).
    chaosActions.push("state-loss")
    await chaosClient.eval(
      "local k=redis.call('keys', ARGV[1]) for i=1,#k do redis.call('del', k[i]) end return #k",
      0,
      "caracal:v1:*",
    )
    return
  }
  throw new Error(`unknown timeline action "${action.action}"`)
}

/** Fires each action at `startedAt + at` ms; resolves when the last one has run. */
function runTimeline(downstreamUrl, timeline, startedAt) {
  const actions = (timeline ?? []).map((action) => ({
    ...action,
    due: startedAt + (action.at ?? 0),
  }))
  if (actions.length === 0) return Promise.resolve()
  return Promise.all(
    actions.map(
      (action) =>
        new Promise((resolve) => {
          const wait = Math.max(0, action.due - Date.now())
          setTimeout(async () => {
            try {
              await applyAction(downstreamUrl, action)
            } catch (error) {
              console.error(
                `timeline action ${action.action} failed: ${error instanceof Error ? error.message : error}`,
              )
            }
            resolve()
          }, wait)
        }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const replicas = Number(demo.topology.replicas ?? 1)
const env = demo.topology.env ?? {}
const downstreamUrl = `http://127.0.0.1:${DOWNSTREAM_PORT}`
const dependency = demo.scenario.dependency ?? {}
const awsQueueName = dependency.upstream
  ? `caracal-demo-${runId.replace(/[^A-Za-z0-9_-]/g, "-")}`
  : undefined

spawnProcess(
  "downstream-mock",
  `${ROOT}apps/downstream-mock/src/main.ts`,
  {
    PORT: String(DOWNSTREAM_PORT),
    LATENCY_MS: String(dependency.latencyMs ?? 30),
    FAILURE_RATE: String(dependency.failureRate ?? 0),
    FAILURE_STATUS: String(dependency.failureStatus ?? 500),
    FAIL_REGIONS: (dependency.failRegions ?? []).join(","),
    FAIL_TENANTS: (dependency.failTenants ?? []).join(","),
    HANG_RATE: String(dependency.hangRate ?? 0),
    HANG_REGIONS: (dependency.hangRegions ?? []).join(","),
    HANG_TENANTS: (dependency.hangTenants ?? []).join(","),
    BODY_DELAY_MS: String(dependency.bodyDelayMs ?? 0),
    CAPACITY: String(dependency.capacity ?? 0),
    ...(dependency.upstream
      ? {
          UPSTREAM_URL: dependency.upstream,
          AWS_DIRECT_URL: dependency.upstream,
          AWS_QUEUE_NAME: awsQueueName,
          AWS_REGION: dependency.region ?? "us-east-1",
          FAIL_AFTER_UPSTREAM: String(dependency.failAfterUpstream ?? 0),
          FAIL_TARGET: dependency.failTarget ?? "SendMessage",
        }
      : {}),
  },
  downstreamUrl,
)
await waitHealthy(downstreamUrl, "downstream-mock")

const targets = []
for (let index = 0; index < replicas; index += 1) {
  const port = PORT_BASE + index
  targets.push(`http://127.0.0.1:${port}`)
  spawnProcess(
    `replica-${index}`,
    `${ROOT}apps/partner-api/src/main.ts`,
    {
      ...env,
      DEMO: demo.id,
      RUN_ID: runId,
      REPLICA: String(index),
      PORT: String(port),
      // The structured fields are authoritative: a demo's `topology` block is
      // the whole point, so it must not be spelled twice in `env`.
      TOPOLOGY: demo.topology.policies,
      SCOPE: demo.topology.scope,
      // A run-unique namespace: the distributed breaker and bulkhead keep their
      // state in Redis keyed by the namespace, so re-running a demo must not
      // inherit the previous run's OPEN breaker (see findings.md, finding 10).
      CARACAL_NAMESPACE: `caracal-demo:${runId}`,
      DOWNSTREAM_URL: downstreamUrl,
      EVENTS_FILE: `${runDirectory}/replica-${index}.ndjson`,
      META_FILE: `${runDirectory}/replica-${index}.meta.json`,
      // One ramp log per replica: every replica runs a controller, so the merged
      // file is the history of the race, not of a single writer.
      RAMP_FILE: `${runDirectory}/ramp-${index}.ndjson`,
      ...(awsQueueName
        ? {
            AWS_ENDPOINT_URL: downstreamUrl,
            AWS_QUEUE_NAME: awsQueueName,
            AWS_REGION: dependency.region ?? "us-east-1",
          }
        : {}),
    },
    `http://127.0.0.1:${port}`,
  )
}
for (const target of targets) await waitHealthy(target, "replica")

await resetWitness(downstreamUrl)

// Chaos: the witness is Redis itself - the live lease count, sampled on the
// coordinator's own clock, independent of both the replicas and the load.
if (demo.chaos) {
  chaosClient = new Redis(
    demo.topology.env?.REDIS_URL ?? "redis://127.0.0.1:6379",
    { lazyConnect: true },
  )
  await chaosClient.connect()
}

const startedAt = Date.now()
let sampling = true
const samplerPromise = (async () => {
  while (sampling && chaosClient) {
    const live = await sampleLiveLeases(chaosClient)
    leaseSamples.push(live)
    if (live > maxLiveLeases) maxLiveLeases = live
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})()

const loadPromise = runLoad(targets, downstreamUrl, {
  durationMs,
  concurrency: Number(demo.scenario.concurrency ?? 10),
  targetRps: demo.scenario.targetRps,
  operations: demo.scenario.operations,
  seed: demo.scenario.seed ?? 1,
  tenantPool: demo.scenario.tenantPool,
})
// Timeline actions fire while the load runs, on the same event loop.
await runTimeline(downstreamUrl, demo.timeline, startedAt)
const { client, witness, byOperation } = await loadPromise
// Read the witness's timeline before `stopAll`: the dependency is what measured
// the concurrency the ramp was supposed to bound.
const rampTimeline = demo.topology.env?.RAMP
  ? await readTimeline(downstreamUrl)
  : []
sampling = false
await samplerPromise

if (LIVE) {
  console.log("\nlive mode: processes left running (Ctrl+C to stop)")
  console.log(`  downstream-mock ${downstreamUrl}  (_witness, _metrics)`)
  targets.forEach((target, index) => {
    console.log(`  replica ${index}       ${target}`)
  })
  console.log(`  run directory          ${runDirectory}`)
  await new Promise((resolve) => {
    process.on("SIGINT", () => resolve())
    process.on("SIGTERM", () => resolve())
    setInterval(() => {}, 60_000) // keep the loop alive while children run
  })
  await stopAll()
  process.exit(0)
}

await stopAll()

// Final lease count after the dust settles: releases and lease expiry should
// leave nothing live. A non-zero value is a leaked permit.
let finalLiveLeases = 0
if (chaosClient) {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  finalLiveLeases = await sampleLiveLeases(chaosClient)
  chaosClient.disconnect()
  chaosClient = null
}

// ---------------------------------------------------------------------------
// Aggregate what the replicas and the dependency wrote, into one summary.
// ---------------------------------------------------------------------------

const summarizer = new EventSummarizer()
const coordination = { commands: 0, evalsha: 0, eval: 0, errors: 0 }
const rampLines = []
let replicaConfig = {}

for (let index = 0; index < replicas; index += 1) {
  const eventsFile = `${runDirectory}/replica-${index}.ndjson`
  try {
    const lines = readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
    for (const line of lines) summarizer.record(JSON.parse(line))
  } catch {
    // A replica that never flushed (no traffic, or killed before a flush) has
    // nothing to contribute; the witness and client views still decide the run.
  }
  try {
    const lines = readFileSync(`${runDirectory}/ramp-${index}.ndjson`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
    for (const line of lines) rampLines.push(JSON.parse(line))
  } catch {
    // No ramp configured in this run: no file, nothing to merge.
  }
  try {
    const meta = JSON.parse(
      readFileSync(`${runDirectory}/replica-${index}.meta.json`, "utf8"),
    )
    replicaConfig = meta.config
    if (meta.coordination) {
      coordination.commands += meta.coordination.commands
      coordination.evalsha += meta.coordination.evalsha
      coordination.eval += meta.coordination.eval
      coordination.errors += meta.coordination.errors
    }
  } catch {
    // A killed replica never wrote its meta; the surviving ones decide the config
    // and the coordination tally simply lacks the dead one's share.
  }
}

// The permit ledger, measured by the demo because only the demo knows which
// replicas were asked to stop: every permit a bulkhead admitted has to come back.
// `bulkhead.lease-lost` is not subtracted - a holder that lost its lease still
// releases the permit when its work ends (study 07 records both at 126).
{
  const view = summarizer.snapshot()
  const admitted = view.eventsByType?.["bulkhead.admitted"] ?? 0
  const released = view.eventsByType?.["bulkhead.released"] ?? 0
  summarizer.setPermitsLeaked(admitted - released)
}

const caracal = summarizer.snapshot()
const executions = Object.values(caracal.executionsByOutcome).reduce(
  (sum, value) => sum + value,
  0,
)
// Any topology that talks to a coordinator pays for it, delegated or not. The
// cost panel is what a reader weighs the topology against, so it cannot be
// limited to the strict one - that would hide the delegated row's own cost.
const coordinated = demo.topology.policies !== "local"

// The ramp view: applied writes from every replica, merged, plus the witness's
// own timeline so each step can be checked against what the dependency saw.
let ramp
if (rampLines.length > 0) {
  const applied = rampLines.filter(
    (line) => line.phase !== "conflict" && line.phase !== "abort",
  )
  const phases = {}
  for (const line of rampLines) {
    phases[line.phase] = (phases[line.phase] ?? 0) + 1
  }
  const samples = rampTimeline
  const first = rampLines[0]
  ramp = {
    target: first.target,
    baseline: first.baseline,
    floor: first.floor,
    // Every replica stamps on this machine's clock; sorting makes the merged
    // history a single timeline.
    steps: [...applied].sort((left, right) => left.at - right.at),
    phases,
    conflicts: phases.conflict ?? 0,
    restored: Boolean(phases.restore),
    samples,
  }
}

const summary = createSummary({
  demo: demo.id,
  title: demo.title,
  caracalVersion: CARACAL_VERSION,
  caracalSource: CARACAL_SOURCE,
  topology: {
    policies: demo.topology.policies,
    scope: demo.topology.scope,
    config: replicaConfig,
  },
  workload: {
    durationMs,
    concurrency: Number(demo.scenario.concurrency ?? 10),
    replicas,
    byOperation,
  },
  client,
  witness,
  caracal,
  ...(ramp ? { ramp } : {}),
  ...(coordinated
    ? {
        coordination: {
          ...coordination,
          roundTripsPerExecution: Number(
            (coordination.commands / Math.max(1, executions)).toFixed(2),
          ),
        },
      }
    : {}),
  ...(demo.chaos
    ? {
        chaos: {
          samples: leaseSamples.length,
          maxLiveLeases,
          finalLiveLeases,
          actions: chaosActions,
          limit: Number(demo.chaos.limit),
        },
      }
    : {}),
  notes: [demo.question ?? "", `runId: ${runId}`],
})

finalizeSummary(summary, demo.checks ?? [])
writeSummary(runDirectory, summary)
writeReport(runDirectory, summary)

console.log(`\n${demo.id} - ${demo.title}`)
console.log(`run ${runId} (${replicas} replica(s), ${durationMs}ms)`)
console.log(`  witness peak in-flight: ${summary.witness?.peakInFlight}`)
console.log(
  `  client: ${client.success}/${client.requests} ok, refused ${JSON.stringify(client.refusedByReason)}, ${client.timedOut} timed out`,
)
if (coordinated) {
  console.log(
    `  coordination: ${summary.coordination.roundTripsPerExecution} trips/exec (${coordination.commands} commands)`,
  )
}
if (summary.chaos) {
  console.log(
    `  chaos: max live leases ${summary.chaos.maxLiveLeases}/${summary.chaos.limit}, final ${summary.chaos.finalLiveLeases}, actions [${summary.chaos.actions.join(", ")}]`,
  )
}
if (summary.ramp) {
  const applied = summary.ramp.steps
    .filter((step) => ["start", "step", "complete"].includes(step.phase))
    .map((step) => step.value)
  console.log(
    `  ramp: ${summary.ramp.target} ${applied.join(" -> ")} (${summary.ramp.conflicts} conflict(s), ${summary.ramp.phases.open ?? 0} floor write(s), ${summary.ramp.samples.length} witness sample(s))`,
  )
}
for (const check of summary.checks) {
  console.log(
    `  ${check.passed ? "ok  " : "FAIL"}  ${check.claim}  [${check.actual}]`,
  )
}
console.log(`\n${summary.passed ? "PASS" : "FAIL"} - ${runDirectory}`)
process.exit(summary.passed ? 0 : 1)
