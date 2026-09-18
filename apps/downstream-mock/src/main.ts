/**
 * The dependency every demo exercises, and the witness that measures it.
 *
 * Two jobs, deliberately in one process:
 *
 * 1. Serve a flaky downstream (latency, a failure rate) so the workload has
 *    something real to call.
 * 2. Measure its own concurrency and expose it, so a demo's claim can be decided
 *    on the dependency's numbers rather than on what the library under test says.
 *
 * `peakInFlight` and `peakByScope` are computed from this process's own request
 * lifecycle, not from caracal events - which is what makes "the downstream is the
 * witness" an independent measurement.
 *
 *   node --import tsx apps/downstream-mock/src/main.ts
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

type Behavior = {
  latencyMs: number
  failureRate: number
  failureStatus: number
  /** Regions that fail every request - the blast-radius lever. */
  failRegions: string[]
  /** Tenants that fail every request - the noisy-tenant lever. */
  failTenants: string[]
  /** Rate (0-1) of requests that hang forever (never respond). */
  hangRate: number
  /** Regions that hang every request - the stuck-holder lever. */
  hangRegions: string[]
  /** Tenants that hang every request - the stuck-tenant lever. */
  hangTenants: string[]
  /** Delay between headers and body, so a client can cancel mid-response. */
  bodyDelayMs: number
}

const port = Number(process.env.PORT ?? 4200)
// The dependency's real ceiling: beyond this many in-flight requests it refuses
// new ones (503) rather than degrading. 0 means no ceiling (the default).
const capacity = Number(process.env.CAPACITY ?? 0)
const behavior: Behavior = {
  latencyMs: Number(process.env.LATENCY_MS ?? 30),
  failureRate: Number(process.env.FAILURE_RATE ?? 0),
  failureStatus: Number(process.env.FAILURE_STATUS ?? 500),
  failRegions: (process.env.FAIL_REGIONS ?? "").split(",").filter(Boolean),
  failTenants: (process.env.FAIL_TENANTS ?? "").split(",").filter(Boolean),
  hangRate: Number(process.env.HANG_RATE ?? 0),
  hangRegions: (process.env.HANG_REGIONS ?? "").split(",").filter(Boolean),
  hangTenants: (process.env.HANG_TENANTS ?? "").split(",").filter(Boolean),
  bodyDelayMs: Number(process.env.BODY_DELAY_MS ?? 0),
}

let requests = 0
let failures = 0
let abandoned = 0
let inFlight = 0
let peak = 0
let peakRps = 0
const inFlightByScope = new Map<string, number>()
const peakByScope: Record<string, number> = {}
const requestsByStatus: Record<string, number> = {}
const samples: { at: number; inFlight: number }[] = []
// Arrival timestamps within the last second: a sliding window whose length is the
// dependency's own instantaneous arrival rate. This is the rate-axis witness, the
// complement of `peakInFlight` on the concurrency axis.
const arrivalTimes: number[] = []

// A timeline of in-flight samples, timed on this process's own clock, so a panel
// can draw the exact concurrency curve the bulkhead was supposed to flatten.
setInterval(() => {
  samples.push({ at: Date.now(), inFlight })
  if (samples.length > 100_000) samples.splice(0, 1_000)
}, 10).unref()

function scopeOf(request: IncomingMessage): string {
  const region = request.headers["x-region"]
  const tenant = request.headers["x-tenant-id"]
  if (typeof tenant === "string" && tenant) return `tenant:${tenant}`
  if (typeof region === "string" && region) return `region:${region}`
  return "global"
}

function enter(scope: string): void {
  inFlight += 1
  if (inFlight > peak) peak = inFlight
  const next = (inFlightByScope.get(scope) ?? 0) + 1
  inFlightByScope.set(scope, next)
  peakByScope[scope] = Math.max(peakByScope[scope] ?? 0, next)
}

function leave(scope: string): void {
  inFlight -= 1
  inFlightByScope.set(scope, Math.max(0, (inFlightByScope.get(scope) ?? 1) - 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

async function work(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const scope = scopeOf(request)
  const started = Date.now()
  requests += 1
  // Slide the 1s arrival window so the dependency can report its own rate.
  arrivalTimes.push(started)
  while (
    arrivalTimes.length > 0 &&
    started - (arrivalTimes[0] ?? started) > 1000
  )
    arrivalTimes.shift()
  if (arrivalTimes.length > peakRps) peakRps = arrivalTimes.length
  if (capacity > 0 && inFlight >= capacity) {
    failures += 1
    requestsByStatus["503"] = (requestsByStatus["503"] ?? 0) + 1
    json(response, 503, { error: "overloaded", scope, tookMs: 0 })
    return
  }
  enter(scope)

  const region = request.headers["x-region"]
  const tenant = request.headers["x-tenant-id"]
  const regionHanging =
    typeof region === "string" && behavior.hangRegions.includes(region)
  const tenantHanging =
    typeof tenant === "string" && behavior.hangTenants.includes(tenant)

  try {
    if (regionHanging || tenantHanging || Math.random() < behavior.hangRate) {
      // A hung request holds the connection open until the client aborts (a
      // timeout or a bulkhead lease) - or forever. It never responds.
      requestsByStatus.hang = (requestsByStatus.hang ?? 0) + 1
      await new Promise<void>((resolve) => {
        response.on("close", () => resolve())
      })
      return
    }

    // Fixed latency with jitter, so a p50/p99 spread exists without a model.
    await sleep(behavior.latencyMs + Math.random() * behavior.latencyMs * 0.5)

    const regionFailing =
      typeof region === "string" && behavior.failRegions.includes(region)
    const tenantFailing =
      typeof tenant === "string" && behavior.failTenants.includes(tenant)
    if (
      regionFailing ||
      tenantFailing ||
      Math.random() < behavior.failureRate
    ) {
      failures += 1
      requestsByStatus[String(behavior.failureStatus)] =
        (requestsByStatus[String(behavior.failureStatus)] ?? 0) + 1
      await respond(response, behavior.failureStatus, {
        error: "downstream failure",
        scope,
        tookMs: Date.now() - started,
      })
      return
    }
    requestsByStatus["200"] = (requestsByStatus["200"] ?? 0) + 1
    await respond(response, 200, {
      ok: true,
      scope,
      tookMs: Date.now() - started,
    })
  } finally {
    leave(scope)
  }
}

/**
 * Writes a response, optionally splitting headers from the body so that a
 * client that abandons the body (the adapter's `dispose`) is observable as a
 * `close` before the body was written.
 */
async function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
): Promise<void> {
  response.writeHead(status, { "content-type": "application/json" })
  const payload = JSON.stringify(body)
  if (behavior.bodyDelayMs <= 0) {
    response.end(payload)
    return
  }
  response.flushHeaders()
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    response.on("close", () => {
      if (!response.writableEnded) abandoned += 1
      done()
    })
    setTimeout(() => {
      response.end(payload)
      done()
    }, behavior.bodyDelayMs)
  })
}

function prometheus(): string {
  const lines: string[] = [
    "# HELP downstream_inflight Requests currently in flight, by scope.",
    "# TYPE downstream_inflight gauge",
    "# HELP downstream_peak_inflight Highest in-flight seen since reset.",
    "# TYPE downstream_peak_inflight gauge",
    "# HELP downstream_peak_rps Highest 1-second arrival rate seen since reset.",
    "# TYPE downstream_peak_rps gauge",
    "# HELP downstream_requests_total Requests served, by status.",
    "# TYPE downstream_requests_total counter",
    "# HELP downstream_failures_total Failures served.",
    "# TYPE downstream_failures_total counter",
    "# HELP downstream_capacity The dependency's configured ceiling, 0 = unlimited.",
    "# TYPE downstream_capacity gauge",
  ]
  for (const [scope, count] of inFlightByScope) {
    lines.push(`downstream_inflight{scope="${scope}"} ${count}`)
  }
  for (const [scope, count] of Object.entries(peakByScope)) {
    lines.push(`downstream_peak_inflight{scope="${scope}"} ${count}`)
  }
  lines.push(`downstream_peak_rps ${peakRps}`)
  for (const [status, count] of Object.entries(requestsByStatus)) {
    lines.push(`downstream_requests_total{status="${status}"} ${count}`)
  }
  lines.push(`downstream_failures_total ${failures}`)
  lines.push(`downstream_abandoned_total ${abandoned}`)
  if (capacity > 0) lines.push(`downstream_capacity ${capacity}`)
  return `${lines.join("\n")}\n`
}

function witness() {
  return {
    samples: samples.length,
    peakInFlight: peak,
    peakRps,
    peakByScope,
    requests,
    failures,
    abandoned,
    capacity: capacity > 0 ? capacity : undefined,
  }
}

function reset(): void {
  requests = 0
  failures = 0
  abandoned = 0
  inFlight = 0
  peak = 0
  peakRps = 0
  arrivalTimes.length = 0
  inFlightByScope.clear()
  for (const key of Object.keys(peakByScope)) delete peakByScope[key]
  for (const key of Object.keys(requestsByStatus)) delete requestsByStatus[key]
  samples.length = 0
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost")

  if (url.pathname === "/healthz") {
    response.writeHead(200).end("ok")
    return
  }
  if (url.pathname === "/_admin/shutdown") {
    // Signals are unreliable cross-platform (on Windows, child.kill("SIGTERM")
    // terminates without running handlers), so graceful shutdown is an HTTP
    // endpoint the orchestrator calls. It is also what the chaos demo drives.
    response.writeHead(200).end("ok")
    server.close(() => process.exit(0))
    return
  }
  if (url.pathname === "/_witness") {
    json(response, 200, witness())
    return
  }
  if (url.pathname === "/_metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" })
    response.end(prometheus())
    return
  }
  if (url.pathname === "/_control/reset") {
    reset()
    json(response, 200, witness())
    return
  }
  if (url.pathname === "/_control") {
    if (request.method === "POST") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        try {
          const next = JSON.parse(body || "{}") as Partial<Behavior>
          if (typeof next.latencyMs === "number")
            behavior.latencyMs = next.latencyMs
          if (typeof next.failureRate === "number")
            behavior.failureRate = next.failureRate
          if (typeof next.failureStatus === "number")
            behavior.failureStatus = next.failureStatus
          if (Array.isArray(next.failRegions))
            behavior.failRegions = next.failRegions
          if (Array.isArray(next.failTenants))
            behavior.failTenants = next.failTenants
          if (typeof next.hangRate === "number")
            behavior.hangRate = next.hangRate
          if (Array.isArray(next.hangRegions))
            behavior.hangRegions = next.hangRegions
          if (Array.isArray(next.hangTenants))
            behavior.hangTenants = next.hangTenants
          if (typeof next.bodyDelayMs === "number")
            behavior.bodyDelayMs = next.bodyDelayMs
          json(response, 200, { behavior })
        } catch {
          json(response, 400, { error: "bad body" })
        }
      })
      return
    }
    json(response, 200, { behavior })
    return
  }

  if (request.method === "POST" && url.pathname === "/orders") {
    void work(request, response)
    return
  }
  if (
    url.pathname.startsWith("/orders/") ||
    url.pathname.startsWith("/partner/")
  ) {
    void work(request, response)
    return
  }
  json(response, 404, { error: "not found" })
})

server.listen(port, () => {
  console.log(
    `downstream-mock on :${port} (latency ${behavior.latencyMs}ms, failureRate ${behavior.failureRate})`,
  )
})

process.on("SIGTERM", () => server.close(() => process.exit(0)))
process.on("SIGINT", () => server.close(() => process.exit(0)))
