/**
 * The partner-api service, one replica.
 *
 * A thin HTTP facade over the caracal operations: it turns an incoming request
 * into (a) the operation to run, (b) the `metadata` the scope function reads, and
 * (c) the downstream call, then maps a caracal rejection onto an HTTP status the
 * load generator can distinguish.
 *
 *   node --import tsx apps/partner-api/src/main.ts
 */
import { randomUUID } from "node:crypto"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { createRequire } from "node:module"
import {
  BulkheadRejectedError,
  CircuitOpenError,
  ConfigurationError,
  RateLimitExceededError,
  TimeoutError,
} from "@gkoos/caracal"
import { CoordinatorUnavailableError } from "@gkoos/caracal/redis"
import { Pool } from "pg"
import { ndjsonSink, startObservability } from "caracal-observability"
import {
  buildPolicies,
  createCoordinators,
  createServalCoordinators,
  describeConfig,
  loadConfig,
} from "./index.js"
import { buildOperations } from "./operations.js"
import { openAwsQueue } from "./aws.js"
import { type RampLine, createRampController } from "./ramp.js"

const CARACAL_VERSION = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@gkoos/caracal/package.json"),
    "utf8",
  ),
).version

const config = loadConfig()
const downstreamUrl = (
  process.env.DOWNSTREAM_URL ?? "http://127.0.0.1:4200"
).replace(/\/+$/, "")
const eventsFile = process.env.EVENTS_FILE ?? "replica.ndjson"
const metaFile = process.env.META_FILE ?? "replica.meta.json"
const pool = process.env.POSTGRES_URL
  ? new Pool({ connectionString: process.env.POSTGRES_URL, max: 8 })
  : undefined

const observability = await startObservability({
  serviceName: "caracal-demo-partner-api",
  baseLabels: { demo: config.demo, run_id: config.runId },
  resourceAttributes: { replica: config.replica },
})

const observer = {
  command: (kind: "eval" | "evalsha" | "hmget") =>
    observability.telemetry.metrics.recordCoordinatorCommand(kind),
  error: () => observability.telemetry.metrics.recordCoordinatorError(),
}
const coordinators =
  config.topology === "distributed"
    ? createCoordinators(config, config.namespace, observer)
    : undefined
// The delegated fleet: one session per process, and the same strict coordinators
// underneath as the authority. `config.replica` is stable for the process lifetime,
// which is what makes an incarnation meaningful.
const delegated =
  config.topology === "serval"
    ? createServalCoordinators(
        config,
        config.namespace,
        `replica-${config.replica}`,
        observer,
      )
    : undefined
if (coordinators || delegated) {
  try {
    await coordinators?.connect()
    await delegated?.connect()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `replica ${config.replica}: cannot reach Redis at ${config.redis.url}: ` +
        `${message}\nStart the stack first: npm run stack:up`,
    )
    process.exit(1)
  }
}

const events = ndjsonSink({ path: eventsFile })
const policies = buildPolicies(config, coordinators, delegated)
// The recovery ramp is application policy: the library owns the ceiling, this
// process owns when to move it. Every replica runs one - a probe can close in
// any of them - and compare-and-set makes concurrent ramps converge.
const rampFile = process.env.RAMP_FILE ?? "ramp.ndjson"
const rampBaseline = config.ramp?.baseline
const rampFloor = config.ramp?.floor
const ramp =
  config.ramp && coordinators
    ? createRampController({
        breakerName: config.breaker.name,
        target: config.ramp.target,
        policyName:
          config.ramp.target === "bulkhead"
            ? policies.bulkheadName
            : policies.rateName,
        baseline: config.ramp.baseline,
        floor: config.ramp.floor,
        stepMs: config.ramp.stepMs,
        burst: config.rateLimit.burst,
        managerFor: (scope) => coordinators.configurationFor(scope),
        write: (line: RampLine) =>
          appendFileSync(
            rampFile,
            `${JSON.stringify({
              ...line,
              // Repeated on every line so the summary can read the shape of the
              // ramp from any replica's file.
              baseline: rampBaseline,
              floor: rampFloor,
            })}\n`,
          ),
      })
    : undefined
// Every decision the replicas make flows out through both sinks: ndjson for the
// orchestrator to aggregate, OTLP for the dashboards. Without this, the policies
// would run and the witness would still measure the dependency - but the summary
// could not say *why* a call was shed.
const awsQueue =
  process.env.AWS_ENDPOINT_URL && process.env.AWS_QUEUE_NAME
    ? await openAwsQueue({
        endpoint: process.env.AWS_ENDPOINT_URL,
        queueName: process.env.AWS_QUEUE_NAME,
        region: process.env.AWS_REGION,
      })
    : undefined

const operations = buildOperations(
  policies,
  [events, observability.telemetry.sink(), ...(ramp ? [ramp.sink] : [])],
  pool,
  awsQueue,
)

/** A caracal rejection, mapped to an HTTP status a client can tell apart. */
function httpStatus(error: unknown): {
  status: number
  kind: string
  reason?: string
} {
  if (error instanceof BulkheadRejectedError) {
    return { status: 429, kind: "bulkhead-rejected", reason: error.reason }
  }
  if (error instanceof RateLimitExceededError)
    return { status: 429, kind: "rate-limited" }
  if (error instanceof CircuitOpenError)
    return { status: 503, kind: "breaker-open" }
  if (error instanceof TimeoutError) return { status: 504, kind: "timeout" }
  if (error instanceof CoordinatorUnavailableError) {
    return { status: 503, kind: "coordinator-unavailable" }
  }
  if (error instanceof ConfigurationError) {
    // A stored record the server cannot use: a deployment problem, not backpressure.
    return { status: 500, kind: "configuration-error", reason: error.reason }
  }
  return { status: 500, kind: "error" }
}

/** The metadata that becomes the scope key, from the request the client sent. */
function metadataOf(
  url: URL,
  request: IncomingMessage,
): Record<string, unknown> {
  const region = url.searchParams.get("region") ?? request.headers["x-region"]
  const tenantId =
    url.searchParams.get("tenant") ?? request.headers["x-tenant-id"]
  const metadata: Record<string, unknown> = {}
  if (typeof region === "string" && region) metadata.region = region
  if (typeof tenantId === "string" && tenantId) metadata.tenantId = tenantId
  return metadata
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost")
  const method = request.method ?? "GET"
  const metadata = metadataOf(url, request)

  if (url.pathname === "/report/run") {
    if (!operations.reportRun) {
      response.writeHead(404).end()
      return
    }
    const seconds = Math.min(10, Number(url.searchParams.get("seconds") ?? 2))
    try {
      // `pg_sleep` is the slow dependency: the query runs for `seconds`, the
      // timeout (outside) fires earlier, and because the adapter declares
      // `abort: "unsupported"` the permit is not released until the query ends.
      await operations.reportRun.execute(
        {
          sql: "select pg_sleep($1), $2::text as ok",
          values: [seconds, "ok"],
          replay: "safe",
        },
        { metadata },
      )
      response.writeHead(200).end()
    } catch (error) {
      const mapped = httpStatus(error)
      response.writeHead(mapped.status, {
        "x-caracal": mapped.kind,
        ...(mapped.reason ? { "x-caracal-reason": mapped.reason } : {}),
      })
      response.end()
    }
    return
  }

  if (method === "POST" && url.pathname === "/aws/send") {
    if (!operations.awsSend) {
      response.writeHead(404).end()
      return
    }
    try {
      await operations.awsSend.execute({ body: randomUUID() }, { metadata })
      response.writeHead(200).end()
    } catch (error) {
      const mapped = httpStatus(error)
      response.writeHead(mapped.status, {
        "x-caracal": mapped.kind,
        ...(mapped.reason ? { "x-caracal-reason": mapped.reason } : {}),
      })
      response.end()
    }
    return
  }

  const subject = operations.forPath(method, url.pathname)
  if (!subject) {
    response.writeHead(404).end()
    return
  }

  const headers: Record<string, string> = {}
  if (metadata.region) headers["x-region"] = String(metadata.region)
  if (metadata.tenantId) headers["x-tenant-id"] = String(metadata.tenantId)

  try {
    const result = await subject.execute(
      {
        url: `${downstreamUrl}${url.pathname}`,
        options: { method, headers },
      },
      { metadata },
    )
    // The adapter resolved - that only means headers arrived. Forward the status
    // and release the body, which nobody here needs.
    void result.body?.cancel()
    response.writeHead(result.status, { "x-upstream": "downstream-mock" })
    response.end()
  } catch (error) {
    const mapped = httpStatus(error)
    response.writeHead(mapped.status, {
      "x-caracal": mapped.kind,
      ...(mapped.reason ? { "x-caracal-reason": mapped.reason } : {}),
    })
    response.end()
  }
}

const server = createServer((request, response) => {
  if (request.url?.startsWith("/healthz")) {
    response.writeHead(200).end("ok")
    return
  }
  if (request.url?.startsWith("/_admin/shutdown")) {
    // Windows note: `child.kill("SIGTERM")` terminates without running the
    // handler, so the orchestrator drives a graceful shutdown over HTTP instead.
    response.writeHead(200).end("ok")
    void shutdown()
    return
  }
  if (request.url?.startsWith("/_admin/snapshot")) {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        ...policies.snapshot(),
        ramp: ramp?.snapshot() ?? null,
      }),
    )
    return
  }
  if (request.url?.startsWith("/_admin/freeze")) {
    // Blocks the event loop for `ms`, which is what a GC pause or a suspended VM
    // looks like to the coordinator: no renewals, no releases, no replies.
    const freezeUrl = new URL(request.url, "http://localhost")
    const ms = Number(freezeUrl.searchParams.get("ms") ?? 1000)
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* spin */
    }
    response.writeHead(200).end("froze")
    return
  }
  if (request.url?.startsWith("/_admin/coordinator-cut")) {
    // What an unreachable coordinator looks like to a policy: the client is
    // disconnected and there is no offline queue, so every coordinator call fails at
    // once. Redis keeps its state, so this is the outage - not the data-loss case
    // that `redis.state-loss` produces in the chaos study.
    coordinators?.cut()
    delegated?.cut()
    response.writeHead(200).end("cut")
    return
  }
  if (request.url?.startsWith("/_admin/coordinator-restore")) {
    void (async () => {
      await coordinators?.restore()
      await delegated?.restore()
      response.writeHead(200).end("restored")
    })()
    return
  }
  void handle(request, response)
})

server.listen(config.port, () => {
  console.log(
    `partner-api replica ${config.replica} on :${config.port} (${config.topology}, scope ${config.scope})`,
  )
})

async function shutdown(): Promise<void> {
  // What the orchestrator aggregates after the run: the coordination cost this
  // replica paid, and the configuration that produced it. Written on shutdown so
  // a live replica has nothing to say that a finished one forgot.
  await ramp?.stop()
  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        replica: config.replica,
        port: config.port,
        caracalVersion: CARACAL_VERSION,
        config: describeConfig(config),
        // Same shape as the strict row on purpose: for the delegated topology these
        // counts include every authority read, grant and allocation, so the cost
        // KPI is comparable across topologies rather than flattering the cache.
        coordination: coordinators
          ? { ...coordinators.stats }
          : delegated
            ? { ...delegated.stats }
            : null,
        ramp: ramp?.snapshot() ?? null,
      },
      null,
      2,
    ),
  )
  await events.close()
  await observability.shutdown()
  coordinators?.disconnect()
  await delegated?.disconnect()
  await pool?.end()
  awsQueue?.client.destroy()
  server.close(() => process.exit(0))
}

process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
