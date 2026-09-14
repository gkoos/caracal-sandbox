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
import { readFileSync, writeFileSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { createRequire } from "node:module"
import {
  BulkheadRejectedError,
  CircuitOpenError,
  TimeoutError,
} from "@gkoos/caracal"
import { CoordinatorUnavailableError } from "@gkoos/caracal/redis"
import { Pool } from "pg"
import { ndjsonSink, startObservability } from "caracal-observability"
import {
  buildPolicies,
  createCoordinators,
  describeConfig,
  loadConfig,
} from "./index.js"
import { buildOperations } from "./operations.js"

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

const coordinators =
  config.topology === "distributed"
    ? createCoordinators(config, config.namespace, {
        command: (kind) =>
          observability.telemetry.metrics.recordCoordinatorCommand(kind),
        error: () => observability.telemetry.metrics.recordCoordinatorError(),
      })
    : undefined
if (coordinators) {
  try {
    await coordinators.connect()
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
const policies = buildPolicies(config, coordinators)
// Every decision the replicas make flows out through both sinks: ndjson for the
// orchestrator to aggregate, OTLP for the dashboards. Without this, the policies
// would run and the witness would still measure the dependency - but the summary
// could not say *why* a call was shed.
const operations = buildOperations(
  policies,
  [events, observability.telemetry.sink()],
  pool,
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
  if (error instanceof CircuitOpenError)
    return { status: 503, kind: "breaker-open" }
  if (error instanceof TimeoutError) return { status: 504, kind: "timeout" }
  if (error instanceof CoordinatorUnavailableError) {
    return { status: 503, kind: "coordinator-unavailable" }
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
    response.end(JSON.stringify(policies.snapshot()))
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
  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        replica: config.replica,
        port: config.port,
        caracalVersion: CARACAL_VERSION,
        config: describeConfig(config),
        coordination: coordinators ? { ...coordinators.stats } : null,
      },
      null,
      2,
    ),
  )
  await events.close()
  await observability.shutdown()
  coordinators?.disconnect()
  await pool?.end()
  server.close(() => process.exit(0))
}

process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
