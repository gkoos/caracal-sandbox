/**
 * The traffic driver.
 *
 * It sends tagged requests at the partner-api replicas, records what the caller
 * saw, and - because the witness is the point - pulls the dependency's own
 * numbers once the load has finished. The two views are kept apart on purpose:
 * `client` is the driver's record, `witness` is the dependency's, and the summary
 * that reads them decides claims on the second.
 */
import { latency, type ClientView, type WitnessView } from "caracal-runner"

export type TrafficOperation = {
  name?: string
  method: string
  path: string
  weight: number
  region?: string
  tenant?: string
}

export type TrafficPlan = {
  durationMs: number
  concurrency: number
  /** When set, the whole driver is paced to this many requests per second. */
  targetRps?: number
  operations: TrafficOperation[]
  seed?: number
  /** Generates a tenant per request from a bounded pool, for tenant demos. */
  tenantPool?: { prefix: string; count: number }
}

export type LoadResult = {
  client: ClientView
  witness: WitnessView
  issued: number
  byOperation: Record<string, number>
}

/** Seeded PRNG so a run can be replayed rather than remembered. */
function mulberry32(seedValue: number): () => number {
  let state = seedValue
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick(
  random: () => number,
  operations: readonly TrafficOperation[],
): TrafficOperation {
  const first = operations[0]
  if (!first) throw new Error("traffic plan has no operations")
  const total = operations.reduce((sum, operation) => sum + operation.weight, 0)
  let roll = random() * total
  let result = first
  for (const operation of operations) {
    roll -= operation.weight
    result = operation
    if (roll <= 0) return result
  }
  return result
}

export async function resetWitness(witnessUrl: string): Promise<void> {
  await fetch(`${witnessUrl}/_control/reset`, { method: "POST" })
}

export async function runLoad(
  targets: readonly string[],
  witnessUrl: string,
  plan: TrafficPlan,
): Promise<LoadResult> {
  const random = mulberry32(plan.seed ?? 1)
  const startedAt = Date.now()
  const deadline = startedAt + plan.durationMs

  let issued = 0
  let success = 0
  let failure = 0
  let timedOut = 0
  const refusedByReason: Record<string, number> = {}
  const byOperation: Record<string, number> = {}
  const latencies: number[] = []
  const firstTarget = targets[0]
  if (!firstTarget) throw new Error("runLoad requires at least one target")
  let roundRobin = 0

  // Coarse global pacing: a shared window so the aggregate stays near the target.
  let windowStart = Date.now()
  let windowCount = 0

  async function pace(): Promise<void> {
    if (!plan.targetRps) return
    windowCount += 1
    const elapsed = Date.now() - windowStart
    const budget = Math.floor((elapsed / 1000) * plan.targetRps)
    if (windowCount > budget) {
      const wait = ((windowCount - budget) / plan.targetRps) * 1000
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
    if (elapsed > 1000) {
      windowStart = Date.now()
      windowCount = 0
    }
  }

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const operation = pick(random, plan.operations)
      const label = operation.name ?? `${operation.method} ${operation.path}`
      const target = targets[roundRobin % targets.length] ?? firstTarget
      roundRobin += 1
      const id = String(1 + Math.floor(random() * 100_000))
      const path = operation.path.replace("{id}", id)
      // A fixed tenant on the operation wins; otherwise a bounded pool generates
      // one per request, so a tenant demo can spread load over N tenants.
      const tenant =
        operation.tenant ??
        (plan.tenantPool
          ? `${plan.tenantPool.prefix}${Math.floor(random() * plan.tenantPool.count)}`
          : undefined)
      const query = new URLSearchParams()
      if (operation.region) query.set("region", operation.region)
      if (tenant) query.set("tenant", tenant)
      const url = `${target}${path}${query.size ? `?${query}` : ""}`

      await pace()
      issued += 1
      byOperation[label] = (byOperation[label] ?? 0) + 1
      const at = performance.now()
      try {
        const response = await fetch(url, { method: operation.method })
        latencies.push(performance.now() - at)
        const kind = response.headers.get("x-caracal")
        if (kind) {
          if (kind === "timeout") {
            timedOut += 1
          } else {
            const reason =
              kind === "bulkhead-rejected"
                ? `bulkhead:${response.headers.get("x-caracal-reason") ?? "capacity"}`
                : kind
            refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1
          }
        } else if (response.ok) {
          success += 1
        } else {
          failure += 1
        }
      } catch {
        latencies.push(performance.now() - at)
        failure += 1
      }
    }
  }

  await Promise.all(Array.from({ length: plan.concurrency }, worker))
  const durationMs = Date.now() - startedAt

  const client: ClientView = {
    requests: issued,
    success,
    failure,
    refusedByReason,
    timedOut,
    latencyMs: latency(latencies),
    rps: Math.round((issued / Math.max(1, durationMs)) * 1000),
  }

  const witnessResponse = await fetch(`${witnessUrl}/_witness`)
  const witness = (await witnessResponse.json()) as WitnessView

  return { client, witness, issued, byOperation }
}
